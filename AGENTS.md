# Instruções Obrigatórias para OpenCode / DeepSeek

Antes de executar qualquer comando ou gerar arquivos:
1. Leia e siga todas as regras de `CLAUDE.md` (raiz) e `nestjs-project/CLAUDE.md`.
2. Todo comando `npm`, `npx`, `tsc` ou `jest` DEVE ser executado dentro do container usando `podman compose exec nestjs-api <comando>` (nunca no host Windows).
3. Antes de editar testes, leia `.claude/rules/nestjs-testing.md`.
4. Siga estritamente o workflow em pipeline lendo o `SKILL.md` correspondente em `.claude/skills/<skill>/SKILL.md` antes de produzir cada artefato.
