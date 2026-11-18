# Risk test for S2-1: can Step Functions start a Fargate task with LabRole
# and wait for it to finish (ecs:runTask.sync)?
# Uses the pentest task definition, security group and cluster from main.tf.

resource "aws_sfn_state_machine" "fargate_test" {
  name     = "sm-dev-fargate-test"
  role_arn = data.aws_iam_role.lab.arn

  definition = jsonencode({
    Comment = "Risk test: run the pentest task and wait for it to finish"
    StartAt = "RunPentest"
    States = {
      RunPentest = {
        Type           = "Task"
        Resource       = "arn:aws:states:::ecs:runTask.sync"
        TimeoutSeconds = 300
        Parameters = {
          LaunchType     = "FARGATE"
          Cluster        = aws_ecs_cluster.s0.arn
          TaskDefinition = aws_ecs_task_definition.pentest.arn
          NetworkConfiguration = {
            AwsvpcConfiguration = {
              Subnets        = [data.aws_subnets.public.ids[0]]
              SecurityGroups = [aws_security_group.pentest.id]
              AssignPublicIp = "ENABLED"
            }
          }
          Overrides = {
            ContainerOverrides = [{
              Name = "pentest"
              Environment = [{
                Name      = "TARGET_URL"
                "Value.$" = "$.targetUrl"
              }]
            }]
          }
        }
        End = true
      }
    }
  })
}

output "sfn_arn" {
  value = aws_sfn_state_machine.fargate_test.arn
}
