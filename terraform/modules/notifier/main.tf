data "archive_file" "notifier" {
  type        = "zip"
  source_file = "${path.module}/../../../services/notifier/index.mjs"
  output_path = "${path.root}/.build/notifier.zip"
}

resource "aws_cloudwatch_log_group" "notifier" {
  name              = "/aws/lambda/${var.prefix}-notifier"
  retention_in_days = 14
}

resource "aws_lambda_function" "notifier" {
  function_name    = "${var.prefix}-notifier"
  role             = var.lab_role_arn
  runtime          = "nodejs20.x"
  handler          = "index.handler"
  filename         = data.archive_file.notifier.output_path
  source_code_hash = data.archive_file.notifier.output_base64sha256
  # Must stay below the DLQ visibility timeout (30 seconds) for the SQS trigger
  timeout     = 25
  memory_size = 256

  environment {
    variables = {
      GITHUB_TOKEN_ARN = var.github_token_arn
    }
  }

  depends_on = [aws_cloudwatch_log_group.notifier]
}

# Scan jobs that failed 3 times land in the DLQ. The notifier turns each one into an error status.
resource "aws_lambda_event_source_mapping" "dlq" {
  event_source_arn        = var.dlq_arn
  function_name           = aws_lambda_function.notifier.arn
  batch_size              = 1
  function_response_types = ["ReportBatchItemFailures"]
}
