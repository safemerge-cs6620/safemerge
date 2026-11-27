# Build from the repository root:
#   docker build --platform linux/amd64 --provenance=false -f services/sast-worker/Dockerfile -t sast-worker .
FROM node:20-alpine
COPY --from=public.ecr.aws/awsguru/aws-lambda-adapter:1.1.0 /lambda-adapter /opt/extensions/lambda-adapter
ENV AWS_LWA_PORT=8080 \
    AWS_LWA_READINESS_CHECK_PATH=/ready \
    AWS_LWA_ERROR_STATUS_CODES=500-599 \
    HOME=/tmp
WORKDIR /app/scanner
COPY scanners/sast/package*.json ./
RUN npm ci --omit=dev
COPY scanners/sast/ ./
WORKDIR /app
COPY services/sast-worker/package*.json ./
RUN npm ci --omit=dev
COPY services/sast-worker/src ./src
COPY services/sast-worker/disable-file-routes.cjs services/sast-worker/start.sh ./
RUN sed -i 's/\r$//' start.sh && chmod +x start.sh
# the preload needs the scanner's express
ENV NODE_PATH=/app/scanner/node_modules
USER node
CMD ["/app/start.sh"]
