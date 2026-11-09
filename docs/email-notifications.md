# Notificações por e-mail

O Watchly cria notificações apenas quando uma verificação conclui com `outcome = changed`. Verificações iniciais, sem alterações ou com erro não enviam e-mail. Verificações manuais e automáticas usam o mesmo caminho de persistência.

## Configuração

O envio usa a API REST do Resend directamente, com `fetch`; não existe SDK nem serviço adicional.

- `RESEND_API_KEY`: segredo do Worker, configurado como secret no ambiente pretendido. Nunca colocar em `vars`, ficheiros versionados ou logs.
- `RESEND_FROM_EMAIL`: endereço remetente validado no Resend.
- `WATCHLY_APP_URL`: URL HTTPS da aplicação Watchly, sem credenciais.

Não há valores de produção presumidos neste documento. Sem qualquer configuração obrigatória em falta, os eventos permanecem na outbox pendentes e recebem um código de diagnóstico seguro; não são simulados nem marcados como enviados.

## Persistência e entrega

A migration local `0006_email_notifications.sql` adiciona a preferência por utilizador, desligada por omissão para contas existentes e novas, e a outbox. O utilizador tem de activar os avisos explicitamente. A criação do snapshot, estado `changed` e evento da outbox participa no mesmo batch D1; o evento é associado ao proprietário e ao snapshot exactos. A unicidade de `snapshot_id` impede duplicados.

O Cron despacha até dois eventos por invocação, independentemente do limite de verificações do scheduler. Uma reserva SQL atómica com token e expiração evita que dois Cron enviem o mesmo evento. Erros do fornecedor mantêm o evento pendente com backoff exponencial (máximo de cinco tentativas); reservas expiradas podem ser recuperadas. A falha do dispatcher não altera o resultado do scheduler.

O `Idempotency-Key` do Resend é estável por evento e o corpo da mensagem fica baseado nos dados imutáveis capturados no primeiro claim. Como o Resend retém as chaves por 24 horas, o Watchly encerra tentativas ambíguas após 23 horas para não arriscar um envio duplicado fora da janela de deduplicação ([documentação do Resend](https://resend.com/docs/dashboard/emails/idempotency-keys)). As mensagens contêm apenas o nome da monitorização, data e ligação para a aplicação; não incluem URL monitorizado nem conteúdo da página. O nome é escapado no HTML.

Cada utilizador pode activar ou desactivar os avisos em **Notificações por e-mail**. Eventos pendentes de utilizadores que desactivem a preferência são suprimidos antes do envio. A alteração da preferência vale apenas para o utilizador autenticado.

## Operação e rollout

Aplicar `0006_email_notifications.sql` apenas através do processo de migração aprovado para o ambiente alvo, antes de publicar código que lê a nova coluna/tabela. Esta implementação local não executa migrações remotas nem configura secrets. Validar os secrets e o remetente no ambiente correcto antes de activar o envio.
