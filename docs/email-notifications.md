# Notificações por e-mail

O Watchly envia notificações para alterações reais e para o primeiro erro de um novo incidente. Erros consecutivos pertencem ao mesmo incidente e não geram emails repetidos; uma verificação bem-sucedida rearma a detecção para um incidente posterior. Verificações manuais e automáticas usam o mesmo caminho de persistência.

## Configuração Brevo

O Worker usa directamente `POST https://api.brevo.com/v3/smtp/email` com `fetch`; não há SDK.

- `BREVO_API_KEY`: configurar como secret do Worker; nunca em `vars`, ficheiros versionados, argumentos ou logs.
- `BREVO_SENDER_EMAIL`: endereço de remetente verificado no Brevo.
- `BREVO_SENDER_NAME`: nome visível do remetente.
- `WATCHLY_APP_URL`: URL HTTPS da aplicação, sem credenciais.

A API Brevo usa o header `api-key` e espera `sender`, `to`, `subject`, `htmlContent`, `textContent` e `headers.idempotencyKey`. O dispatcher só marca `sent` quando recebe HTTP 201 com `messageId`. Sem configuração completa, não envia e regista um código de erro seguro na outbox.

## Outbox, idempotência e retries

A migration `0006_email_notifications.sql` guarda a preferência individual, desligada por omissão para utilizadores existentes e novos, e a outbox. A migration local `0007_brevo_notification_events.sql` generaliza a outbox para alterações e incidentes de erro, preservando os registos anteriores. Snapshot, estado e evento são persistidos no mesmo batch D1. A chave de evento única e a transição `last_status != 'error'` impedem notificações duplicadas por retries ou erros consecutivos.

O Cron despacha até dois eventos por invocação com reserva atómica. Uma falha do fornecedor não interrompe o scheduler nem a persistência das verificações. A política mantém até cinco tentativas com backoff exponencial, mas não inicia qualquer retry 25 minutos ou mais após a primeira tentativa. O Brevo documenta uma TTL de 30 minutos para `headers.idempotencyKey`; expirado o limite de segurança local, o evento passa a `failed` com diagnóstico e não é enviado novamente. A chave UUIDv4 é o ID estável do evento e o corpo JSON permanece igual em cada retry.

A chave também é usada em respostas ambíguas: o limite local de 25 minutos deixa margem para a retenção de 30 minutos indicada pela [documentação de idempotência Brevo](https://developers.brevo.com/docs/heterogenous-versions-batch-emails). A API de envio e os campos do pedido estão descritos na [documentação de e-mails transaccionais](https://developers.brevo.com/docs/send-a-transactional-email).

## Limite diário gratuito

O Free da Brevo permite 300 envios por dia UTC, partilhados com quaisquer outros envios da conta; consulte as [limitações oficiais do Free](https://help.brevo.com/hc/en-us/articles/208580669-FAQs-What-are-the-limits-of-the-Free-plan). O Watchly reserva no máximo 250 eventos/outbox por dia UTC, deixando margem para outros envios da conta.

A reserva é contabilizada atomicamente no próprio claim D1, usando o `updated_at` existente da outbox e contando cada evento no máximo uma vez por dia. Inclui tentativas ambíguas/falhadas de forma conservadora: assim, uma resposta perdida não abre uma vaga que possa exceder o limite do fornecedor. Quando chega a 250, não começa novas notificações; eventos ainda não tentados permanecem pendentes e voltam a ser elegíveis no dia UTC seguinte. Retries do mesmo evento já reservado nesse dia continuam permitidos apenas dentro da janela de idempotência.

O limite do Watchly não consegue contabilizar envios feitos fora do Watchly. O total real da conta pode aproximar-se dos 300 devido a outras aplicações, campanhas ou utilizadores; o Free pode ainda colocar mensagens transaccionais numa fila própria quando o limite da conta é atingido. Não activar overages nem funcionalidades pagas.

## Preferências e privacidade

Cada utilizador activa ou desactiva notificações em **Notificações por e-mail**. A migration 0006 deixa a preferência desligada por omissão, incluindo nas contas já existentes. Eventos pendentes de utilizadores que desactivem notificações são suprimidos antes do envio.

As mensagens de alteração incluem nome, URL, data, conteúdo anterior e novo conteúdo, limitados a 4.000 caracteres por excerto, e ligação para a aplicação. As mensagens de erro incluem nome, URL, data, descrição e código HTTP quando disponível. O HTML é escapado antes de ser enviado. A preferência existente é um opt-in global e controla ambos os tipos; não existe uma opção separada para erros.

## Rollout

Para desenvolvimento local, definir `BREVO_API_KEY`, `BREVO_SENDER_EMAIL`, `BREVO_SENDER_NAME` e `WATCHLY_APP_URL` no ambiente local protegido. A chave é exclusivamente server-side. Aplicar as migrations 0006 e 0007 apenas pelo processo aprovado, antes de publicar código que consulta as novas colunas. Esta implementação não executa migrações remotas nem configura secrets. Configurar a chave Brevo como secret e as restantes variáveis no ambiente pretendido antes de activar o envio.
