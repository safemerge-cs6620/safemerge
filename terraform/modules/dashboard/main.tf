# Dashboard hosting and login. CloudFront and Cognito are blocked in Learner Lab, so the
# page is served by a Lambda behind an API Gateway HTTP API (public HTTPS URL), and the
# Lambda handles GitHub OAuth login itself with a signed session cookie.

data "archive_file" "dashboard" {
  type        = "zip"
  source_file = "${path.module}/../../../services/dashboard/index.mjs"
  output_path = "${path.root}/.build/dashboard.zip"
}

resource "aws_cloudwatch_log_group" "dashboard" {
  name              = "/aws/lambda/${var.prefix}-dashboard"
  retention_in_days = 14
}

resource "aws_lambda_function" "dashboard" {
  function_name    = "${var.prefix}-dashboard"
  role             = var.lab_role_arn
  runtime          = "nodejs20.x"
  handler          = "index.handler"
  filename         = data.archive_file.dashboard.output_path
  source_code_hash = data.archive_file.dashboard.output_base64sha256
  timeout          = 10
  memory_size      = 256

  environment {
    variables = {
      OAUTH_SECRET_ARN   = var.oauth_secret_arn
      SESSION_SECRET_ARN = var.session_secret_arn
      ALLOWED_USERS      = var.allowed_users
    }
  }

  depends_on = [aws_cloudwatch_log_group.dashboard]
}

resource "aws_apigatewayv2_api" "dashboard" {
  name          = "${var.prefix}-dashboard-api"
  protocol_type = "HTTP"
}

resource "aws_apigatewayv2_integration" "dashboard" {
  api_id                 = aws_apigatewayv2_api.dashboard.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.dashboard.invoke_arn
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_route" "page" {
  api_id    = aws_apigatewayv2_api.dashboard.id
  route_key = "GET /"
  target    = "integrations/${aws_apigatewayv2_integration.dashboard.id}"
}

# Login flow routes, all handled by the same Lambda
resource "aws_apigatewayv2_route" "auth" {
  for_each  = toset(["GET /login", "GET /callback", "GET /logout"])
  api_id    = aws_apigatewayv2_api.dashboard.id
  route_key = each.value
  target    = "integrations/${aws_apigatewayv2_integration.dashboard.id}"
}

resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.dashboard.id
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
  function_name = aws_lambda_function.dashboard.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.dashboard.execution_arn}/*/*"
}
