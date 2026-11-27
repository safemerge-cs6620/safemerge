# Deploy gate (S2-1): register a task definition with the new image, start staging,
# wait until it is healthy, read its private IP, run the pentest task against it,
# and always stop staging at the end, whether the run passed or failed.
#
# Input:  { "repo": "...", "commitSha": "...", "image": "<registry>/demo-api:<tag>", "mode": "deploy" }
# Result: the execution SUCCEEDS only if the pentest task exits with code 0.
#         Any other outcome FAILS, and staging is stopped before the failure is reported.
# Status: before it ends, the gate posts the safemerge/deploy-gate commit status through the
#         notifier (var.notifier_function_name): success for exit 0, failure for exit 1 (HIGH
#         finding), error for anything else. commitSha must be the full 40-character sha.

data "aws_region" "current" {}

data "aws_vpc" "default" {
  default = true
}

data "aws_subnets" "public" {
  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.default.id]
  }
  filter {
    name   = "default-for-az"
    values = ["true"]
  }
}

# These come from modules/ecs. They are looked up by name so this module does not
# depend on that module's outputs.
data "aws_ecs_cluster" "main" {
  cluster_name = "${var.prefix}-cluster"
}

data "aws_security_group" "staging" {
  name   = "${var.prefix}-staging-sg"
  vpc_id = data.aws_vpc.default.id
}

data "aws_security_group" "pentest" {
  name   = "${var.prefix}-pentest-sg"
  vpc_id = data.aws_vpc.default.id
}

data "aws_ecs_task_definition" "pentest" {
  task_definition = "${var.prefix}-pentest"
}

locals {
  cluster_arn    = data.aws_ecs_cluster.main.arn
  staging_family = "${var.prefix}-staging"
  subnet_ids     = data.aws_subnets.public.ids
  tag_list       = [for k, v in var.task_tags : { Key = k, Value = v }]

  # Same call is used on the success path and on every failure path
  stop_staging = {
    Cluster  = local.cluster_arn
    "Task.$" = "$.staging.taskArn"
    Reason   = "Deploy gate finished"
  }

  catch_before_staging = [{
    ErrorEquals = ["States.ALL"]
    ResultPath  = "$.error"
    Next        = "NotifyBeforeStagingError"
  }]

  catch_with_teardown = [{
    ErrorEquals = ["States.ALL"]
    ResultPath  = "$.error"
    Next        = "StopStagingAfterError"
  }]

  # Link to this execution in the Step Functions console, sent as the status target URL
  execution_url = "States.Format('https://console.aws.amazon.com/states/home?region=${data.aws_region.current.name}#/v2/executions/details/{}', $$.Execution.Id)"

  # One state per commit status the gate can post. Every one calls the notifier with the
  # same input shape and then moves on to "next". If the call fails, "on_error" is used,
  # so the execution still ends in its original result.
  notify_states = { for name, cfg in {
    NotifyPassed = {
      state       = "success"
      description = "Pentest passed on staging"
      next        = "GatePassed"
      on_error    = "StatusNotPosted"
    }
    NotifyHighFindings = {
      state       = "failure"
      description = "Pentest found HIGH severity issues"
      next        = "GateFailed"
      on_error    = "GateFailed"
    }
    NotifyError = {
      state       = "error"
      description = "Deploy gate error, see the Step Functions execution"
      next        = "GateFailed"
      on_error    = "GateFailed"
    }
    NotifyTeardownError = {
      state       = "error"
      description = "Pentest finished but staging could not be stopped"
      next        = "TeardownFailed"
      on_error    = "TeardownFailed"
    }
    NotifyBeforeStagingError = {
      state       = "error"
      description = "Staging could not be started"
      next        = "FailBeforeStaging"
      on_error    = "FailBeforeStaging"
    }
    NotifyStagingStopped = {
      state       = "error"
      description = "Staging stopped before it became healthy"
      next        = "StagingStopped"
      on_error    = "StagingStopped"
    }
    } : name => {
    Type           = "Task"
    Resource       = "arn:aws:states:::lambda:invoke"
    TimeoutSeconds = 30
    Parameters = {
      FunctionName = var.notifier_function_name
      Payload = {
        "repo.$"      = "$.repo"
        "sha.$"       = "$.commitSha"
        context       = "safemerge/deploy-gate"
        state         = cfg.state
        description   = cfg.description
        "targetUrl.$" = local.execution_url
      }
    }
    Retry = [{
      ErrorEquals     = ["Lambda.ServiceException", "Lambda.AWSLambdaException", "Lambda.SdkClientException", "Lambda.TooManyRequestsException"]
      IntervalSeconds = 2
      MaxAttempts     = 3
      BackoffRate     = 2
    }]
    ResultPath = null
    Catch = [{
      ErrorEquals = ["States.ALL"]
      ResultPath  = "$.notifyError"
      Next        = cfg.on_error
    }]
    Next = cfg.next
  } }
}

resource "aws_sfn_state_machine" "gate" {
  name     = "${var.prefix}-deploy-gate"
  role_arn = var.lab_role_arn

  definition = jsonencode({
    Comment = "SafeMerge deploy gate: staging + pentest, always tears staging down"
    StartAt = "RegisterStagingTaskDefinition"
    States = merge({

      # 1. A running task cannot have its image overridden, so every new image
      #    needs a new task definition revision. This is how tasks get the new image.
      #    The container settings mirror the staging task definition in modules/ecs.
      RegisterStagingTaskDefinition = {
        Type           = "Task"
        Resource       = "arn:aws:states:::aws-sdk:ecs:registerTaskDefinition"
        TimeoutSeconds = 30
        Parameters = {
          Family                  = local.staging_family
          NetworkMode             = "awsvpc"
          RequiresCompatibilities = ["FARGATE"]
          Cpu                     = "256"
          Memory                  = "512"
          ExecutionRoleArn        = var.lab_role_arn
          TaskRoleArn             = var.lab_role_arn
          RuntimePlatform = {
            CpuArchitecture       = "X86_64"
            OperatingSystemFamily = "LINUX"
          }
          ContainerDefinitions = [{
            Name        = "staging"
            "Image.$"   = "$.image"
            Essential   = true
            PortMappings = [{
              ContainerPort = 4000
              Protocol      = "tcp"
            }]
            HealthCheck = {
              Command     = ["CMD-SHELL", "wget -q -O- http://localhost:4000/health || exit 1"]
              Interval    = 10
              Timeout     = 5
              Retries     = 3
              StartPeriod = 10
            }
            LogConfiguration = {
              LogDriver = "awslogs"
              Options = {
                "awslogs-group"         = "/${var.prefix}/staging"
                "awslogs-region"        = data.aws_region.current.name
                "awslogs-stream-prefix" = "staging"
              }
            }
          }]
          Tags = local.tag_list
        }
        ResultSelector = { "arn.$" = "$.TaskDefinition.TaskDefinitionArn" }
        ResultPath     = "$.stagingDefinition"
        Catch          = local.catch_before_staging
        Next           = "StartStaging"
      }

      # 2. Start staging and do not wait for it
      StartStaging = {
        Type           = "Task"
        Resource       = "arn:aws:states:::aws-sdk:ecs:runTask"
        TimeoutSeconds = 60
        Parameters = {
          Cluster           = local.cluster_arn
          "TaskDefinition.$" = "$.stagingDefinition.arn"
          LaunchType        = "FARGATE"
          Count             = 1
          PropagateTags     = "TASK_DEFINITION"
          NetworkConfiguration = {
            AwsvpcConfiguration = {
              Subnets        = local.subnet_ids
              SecurityGroups = [data.aws_security_group.staging.id]
              AssignPublicIp = "ENABLED"
            }
          }
        }
        ResultSelector = { "taskArn.$" = "$.Tasks[0].TaskArn" }
        ResultPath     = "$.staging"
        Catch          = local.catch_before_staging
        Next           = "InitPoll"
      }

      # 3. Poll until ECS reports the task HEALTHY (its /health check passes).
      #    A counter limits the loop, because a state machine timeout cannot be caught.
      InitPoll = {
        Type       = "Pass"
        Result     = { count = 0 }
        ResultPath = "$.poll"
        Next       = "WaitBeforePoll"
      }

      WaitBeforePoll = {
        Type    = "Wait"
        Seconds = 10
        Next    = "DescribeStaging"
      }

      DescribeStaging = {
        Type           = "Task"
        Resource       = "arn:aws:states:::aws-sdk:ecs:describeTasks"
        TimeoutSeconds = 30
        Parameters = {
          Cluster   = local.cluster_arn
          "Tasks.$" = "States.Array($.staging.taskArn)"
        }
        ResultPath = "$.described"
        Catch      = local.catch_with_teardown
        Next       = "CheckHealth"
      }

      CheckHealth = {
        Type = "Choice"
        Choices = [
          {
            And = [
              { Variable = "$.described.Tasks[0].HealthStatus", IsPresent = true },
              { Variable = "$.described.Tasks[0].HealthStatus", StringEquals = "HEALTHY" }
            ]
            Next = "RunPentest"
          },
          {
            Variable     = "$.described.Tasks[0].LastStatus"
            StringEquals = "STOPPED"
            Next         = "NotifyStagingStopped"
          },
          {
            Variable                 = "$.poll.count"
            NumericGreaterThanEquals = var.max_health_polls
            Next                     = "HealthTimeout"
          }
        ]
        Default = "IncrementPoll"
      }

      IncrementPoll = {
        Type       = "Pass"
        Parameters = { "count.$" = "States.MathAdd($.poll.count, 1)" }
        ResultPath = "$.poll"
        Next       = "WaitBeforePoll"
      }

      HealthTimeout = {
        Type = "Pass"
        Result = {
          Error = "StagingNotHealthy"
          Cause = "The staging task was not healthy within the polling limit"
        }
        ResultPath = "$.error"
        Next       = "StopStagingAfterError"
      }

      # 4. Run the pentest task and wait for it. The private IP comes from the task
      #    description, and staging only accepts port 4000 from the pentest security group.
      RunPentest = {
        Type           = "Task"
        Resource       = "arn:aws:states:::ecs:runTask.sync"
        TimeoutSeconds = 300
        Parameters = {
          LaunchType     = "FARGATE"
          Cluster        = local.cluster_arn
          TaskDefinition = data.aws_ecs_task_definition.pentest.arn
          PropagateTags  = "TASK_DEFINITION"
          NetworkConfiguration = {
            AwsvpcConfiguration = {
              Subnets        = local.subnet_ids
              SecurityGroups = [data.aws_security_group.pentest.id]
              AssignPublicIp = "ENABLED"
            }
          }
          Overrides = {
            ContainerOverrides = [{
              Name = "pentest"
              Environment = [{
                Name      = "TARGET_URL"
                "Value.$" = "States.Format('http://{}:4000', $.described.Tasks[0].Containers[0].NetworkInterfaces[0].PrivateIpv4Address)"
              }]
            }]
          }
        }
        ResultSelector = {
          "taskArn.$"  = "$.TaskArn"
          "exitCode.$" = "$.Containers[0].ExitCode"
        }
        ResultPath = "$.pentest"
        # A non-zero exit code from the container ends the task with States.TaskFailed.
        # Remember that, so the exit code is read only for this failure and not for others.
        Catch = [
          {
            ErrorEquals = ["States.TaskFailed"]
            ResultPath  = "$.error"
            Next        = "MarkPentestFailed"
          },
          {
            ErrorEquals = ["States.ALL"]
            ResultPath  = "$.error"
            Next        = "StopStagingAfterError"
          }
        ]
        Next = "StopStaging"
      }

      MarkPentestFailed = {
        Type       = "Pass"
        Result     = true
        ResultPath = "$.pentestTaskFailed"
        Next       = "StopStagingAfterError"
      }

      # 5a. Success path: stop staging, post the success status, then succeed
      StopStaging = {
        Type           = "Task"
        Resource       = "arn:aws:states:::aws-sdk:ecs:stopTask"
        TimeoutSeconds = 30
        Parameters     = local.stop_staging
        ResultPath     = null
        Catch = [{
          ErrorEquals = ["States.ALL"]
          ResultPath  = "$.error"
          Next        = "NotifyTeardownError"
        }]
        Next = "NotifyPassed"
      }

      # 5b. Failure path: stop staging first, then fail with the original error
      StopStagingAfterError = {
        Type           = "Task"
        Resource       = "arn:aws:states:::aws-sdk:ecs:stopTask"
        TimeoutSeconds = 30
        Parameters     = local.stop_staging
        ResultPath     = null
        Catch = [{
          ErrorEquals = ["States.ALL"]
          ResultPath  = "$.teardownError"
          Next        = "ClassifyFailure"
        }]
        Next = "ClassifyFailure"
      }

      # 5c. Staging is stopped. Decide which status to post. Only a failed pentest task has an
      #     exit code in its Cause (a JSON string), so only that case is parsed.
      ClassifyFailure = {
        Type = "Choice"
        Choices = [{
          Variable  = "$.pentestTaskFailed"
          IsPresent = true
          Next      = "ParsePentestFailure"
        }]
        Default = "NotifyError"
      }

      ParsePentestFailure = {
        Type       = "Pass"
        Parameters = { "task.$" = "States.StringToJson($.error.Cause)" }
        ResultPath = "$.pentestFailure"
        Next       = "CheckPentestExitCode"
      }

      # Exit 1 = a HIGH test failed (failure). Exit 2, exit 3 and a missing exit code are errors.
      CheckPentestExitCode = {
        Type = "Choice"
        Choices = [{
          And = [
            { Variable = "$.pentestFailure.task.Containers[0].ExitCode", IsPresent = true },
            { Variable = "$.pentestFailure.task.Containers[0].ExitCode", NumericEquals = 1 }
          ]
          Next = "NotifyHighFindings"
        }]
        Default = "NotifyError"
      }

      StatusNotPosted = {
        Type  = "Fail"
        Error = "StatusNotPosted"
        Cause = "The pentest passed but the commit status could not be posted."
      }

      GatePassed = {
        Type = "Succeed"
      }

      GateFailed = {
        Type      = "Fail"
        ErrorPath = "$.error.Error"
        CausePath = "$.error.Cause"
      }

      FailBeforeStaging = {
        Type      = "Fail"
        ErrorPath = "$.error.Error"
        CausePath = "$.error.Cause"
      }

      StagingStopped = {
        Type  = "Fail"
        Error = "StagingStopped"
        Cause = "The staging task stopped before it became healthy. Check the staging log group."
      }

      TeardownFailed = {
        Type  = "Fail"
        Error = "TeardownFailed"
        Cause = "The pentest finished but the staging task could not be stopped."
      }
    }, local.notify_states)
  })
}
