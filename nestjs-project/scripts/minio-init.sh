#!/bin/sh
set -eu

until mc alias set local "$S3_ENDPOINT" "$S3_ACCESS_KEY" "$S3_SECRET_KEY"; do
  echo "Waiting for MinIO at $S3_ENDPOINT..."
  sleep 2
done

mc mb --ignore-existing "local/$S3_BUCKET"
mc anonymous set none "local/$S3_BUCKET"

CORS_FILE="$(mktemp)"
cat > "$CORS_FILE" <<'EOF'
<CORSConfiguration>
  <CORSRule>
    <AllowedOrigin>*</AllowedOrigin>
    <AllowedMethod>GET</AllowedMethod>
    <AllowedMethod>PUT</AllowedMethod>
    <AllowedMethod>POST</AllowedMethod>
    <AllowedMethod>HEAD</AllowedMethod>
    <AllowedHeader>*</AllowedHeader>
    <ExposeHeader>ETag</ExposeHeader>
    <ExposeHeader>Content-Range</ExposeHeader>
    <ExposeHeader>Accept-Ranges</ExposeHeader>
    <ExposeHeader>Content-Length</ExposeHeader>
    <MaxAgeSeconds>3600</MaxAgeSeconds>
  </CORSRule>
</CORSConfiguration>
EOF

if MC_OUT="$(mc cors set "local/$S3_BUCKET" "$CORS_FILE" 2>&1)"; then
  echo "Bucket CORS applied to '$S3_BUCKET'."
else
  case "$MC_OUT" in
    *"not implemented"*)
      echo "WARN: this MinIO build does not support bucket-level CORS (PutBucketCors)." >&2
      echo "WARN: CORS exposure relies on MINIO_API_CORS_ALLOW_ORIGIN." >&2
      ;;
    *)
      echo "$MC_OUT" >&2
      exit 1
      ;;
  esac
fi
rm -f "$CORS_FILE"

echo "MinIO bucket '$S3_BUCKET' ready (private)."
