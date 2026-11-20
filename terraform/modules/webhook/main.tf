# Zip the handler. It has no npm dependencies (AWS SDK v3 is in the Node 20 runtime).
data "archive_file" "webhook" {
  type        = "zip"
  source_file = "${path.module}/../../../services/webhook/index.mjs"
  output_path = "${path.root}/.build/webhook.zip"
}

resource "aws_cloudwatch_log_group" "webhook" {
  name              = "/aws/lambda/${var.prefix}-webhook"
  retention_in_days = 14
}

resource "aws_lambda_function" "webhook" {
  function_name    = "${var.prefix}-webhook"
  role             = var.lab_role_arn
  runtime          = "nodejs20.x"
  handler          = "index.handler"
  filename         = data.archive_file.webhook.output_path
  source_code_hash = data.archive_file.webhook.output_base64sha256
  timeout          = 10
  memory_size      = 256

  environment {
    variables = {
      QUEUE_URL          = var.queue_url
      WEBHOOK_SECRET_ARN = var.webhook_secret_arn
      GITHUB_TOKEN_ARN   = var.github_token_arn
    }
  }

  depends_on = [aws_cloudwatch_log_group.webhook]
}

# Public HTTPS entry point for GitHub webhooks
resource "aws_apigatewayv2_api" "webhook" {
  name          = "${var.prefix}-webhook-api"
  protocol_type = "HTTP"
}

resource "aws_apigatewayv2_integration" "webhook" {
  api_id                 = aws_apigatewayv2_api.webhook.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.webhook.invoke_arn
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_route" "webhook" {
  api_id    = aws_apigatewayv2_api.webhook.id
  route_key = "POST /webhook"
  target    = "integrations/${aws_apigatewayv2_integration.webhook.id}"
}

resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.webhook.id
  name        = "$default"
  auto_deploy = true

  # Basic throttling so a flood of requests cannot run up Lambda costs
  default_route_settings {
    throttling_burst_limit = 20
    throttling_rate_limit  = 10
  }
}

resource "aws_lambda_permission" "apigw" {
  statement_id  = "AllowApiGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.webhook.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.webhook.execution_arn}/*/*"
}
