docker stop 9router
docker rm 9router
docker build -f Dockerfile.local -t 9router .
docker run -d --name 9router -p 20128:20128 --env-file .env -e DATA_DIR=/app/data -v 9router-data:/app/data 9router
