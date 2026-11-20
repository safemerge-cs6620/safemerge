output "webhook_url" {
  value = "${aws_apigatewayv2_api.webhook.api_endpoint}/webhook"
}

output "function_name" {
  value = aws_lambda_function.webhook.function_name
}
