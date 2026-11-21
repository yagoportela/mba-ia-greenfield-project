# StreamTube API

API REST do StreamTube, desenvolvida com NestJS, TypeScript, PostgreSQL, Redis, MinIO e Mailpit.

## Requisitos

- Docker Compose ou Podman Compose
- Opcional: Node.js 25 para executar a API diretamente no Windows

Este projeto foi configurado para rodar dentro de containers. As dependencias nativas e os artefatos de compilacao ficam no ambiente Linux dos containers.

## Configuracao

O arquivo `.env` contem a configuracao local padrao:

```env
DB_HOST=localhost
MAIL_HOST=localhost
S3_ENDPOINT=http://localhost:9000
REDIS_HOST=localhost
```

No modo Docker, o `compose.yaml` substitui automaticamente esses enderecos pelos nomes dos containers:

- `db`
- `mailpit`
- `minio`
- `redis`

Nao altere o `.env` para `db` ou outros nomes internos ao tentar executar a API diretamente no Windows.

## Como rodar com Docker ou Podman

Na pasta `nestjs-project`, execute:

```powershell
podman compose up -d
```

No ambiente que possui Docker Desktop:

```powershell
docker compose up -d
```

Esse comando inicia:

| Servico | Porta |
|---|---:|
| API NestJS | 3000 |
| PostgreSQL | 5432 |
| Redis | 6379 |
| MinIO API | 9000 |
| MinIO Console | 9001 |
| Mailpit SMTP | 1025 |
| Mailpit Web | 8025 |

Instale as dependencias dentro do container:

```powershell
podman compose exec nestjs-api npm install
```

Com Docker:

```powershell
docker compose exec nestjs-api npm install
```

Inicie a API em modo watch:

```powershell
podman compose exec nestjs-api npm run start:dev
```

Com Docker:

```powershell
docker compose exec nestjs-api npm run start:dev
```

## URLs

- API: http://localhost:3000
- Swagger: http://localhost:3000/api/docs
- Mailpit: http://localhost:8025
- MinIO Console: http://localhost:9001

O Swagger esta habilitado por padrao quando esta configuracao existe no `.env`:

```env
SWAGGER_ENABLED=true
```

## Executar diretamente no Windows

Primeiro inicie apenas a infraestrutura:

```powershell
podman compose up -d db redis mailpit minio minio-init
```

Em seguida, no mesmo diretorio do projeto:

```powershell
npm install
npm run start:dev
```

Mantenha `.env` com os enderecos `localhost`, pois a aplicacao sera executada no Windows e nao dentro da rede Docker/Podman.

## Verificacao

Verifique os containers:

```powershell
podman compose ps
```

Verifique o PostgreSQL:

```powershell
podman compose exec db pg_isready -U streamtube
```

Verifique a API:

```powershell
curl.exe http://localhost:3000
```

Resposta esperada:

```text
Hello World!
```

## Testes

Testes unitarios e de integracao devem ser executados dentro do container:

```powershell
podman compose exec nestjs-api npm test -- --runInBand
```

Testes end-to-end:

```powershell
podman compose exec nestjs-api npm run test:e2e -- --runInBand
```

Com Docker, substitua `podman` por `docker` nos comandos.

## Build e verificacoes

```powershell
podman compose exec nestjs-api npm run build
podman compose exec nestjs-api npx tsc --noEmit
podman compose exec nestjs-api npm run lint
```

## Parar o projeto

Para parar os containers mantendo os volumes:

```powershell
podman compose stop
```

Para parar e remover os containers:

```powershell
podman compose down
```

Para remover tambem os volumes persistentes:

```powershell
podman compose down -v
```
