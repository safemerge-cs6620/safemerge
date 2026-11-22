output "dashboard_url" {
  value = aws_apigatewayv2_api.dashboard.api_endpoint
}

# Used in part 2 to add login routes and the authorizer to the same API
output "api_id" {
  value = aws_apigatewayv2_api.dashboard.id
}

output "api_execution_arn" {
  value = aws_apigatewayv2_api.dashboard.execution_arn
}
