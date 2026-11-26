resource "aws_cloudwatch_log_group" "worker" {
  name              = "/aws/lambda/${var.prefix}-sast-worker"
  retention_in_days = 14
}

resource "aws_lambda_function" "worker" {
  function_name = "${var.prefix}-sast-worker"
  role          = var.lab_role_arn
  package_type  = "Image"
  image_uri     = "${var.ecr_repository_url}:${var.image_tag}"
  architectures = ["x86_64"]
  timeout       = var.timeout_seconds
  memory_size   = var.memory_mb

  environment {
    variables = {
      SCANS_TABLE            = var.scans_table_name
      REPORTS_BUCKET         = var.reports_bucket_name
      GITHUB_TOKEN_SECRET_ID = var.github_token_secret_id
      NOTIFIER_FUNCTION_NAME = var.notifier_function_name
      DASHBOARD_URL          = var.dashboard_url
    }
  }

  depends_on = [aws_cloudwatch_log_group.worker]
}

resource "aws_lambda_event_source_mapping" "queue" {
  event_source_arn        = var.queue_arn
  function_name           = aws_lambda_function.worker.arn
  batch_size              = 1
  function_response_types = ["ReportBatchItemFailures"]
}
