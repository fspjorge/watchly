# Integração do Worker com Cloud Run

O motor é escolhido exclusivamente pelo ambiente do Worker através de `CHECK_ENGINE`:

- `cloudflare` (valor predefinido): utiliza o motor existente no Worker;
- `google`: executa a recolha no Cloud Run e devolve conteúdo normalizado e hash ao Worker.

O scheduler, os leases, a comparação com snapshots, o estado e toda a persistência continuam no Worker/D1. A chamada ao Cloud Run acontece depois da aquisição do lease. Uma falha remota é registada pelo fluxo de erro existente; não há fallback para Cloudflare.

Para configurar posteriormente um ambiente Cloudflare, definir `CHECK_ENGINE=google` e `CLOUD_RUN_URL` como variáveis desse ambiente, e provisionar `WATCHLY_HMAC_SECRET` como secret do Worker (por exemplo, através do comando `wrangler secret put WATCHLY_HMAC_SECRET`). O valor do secret não deve ser incluído no `wrangler.jsonc`, em `.dev.vars` versionado ou nos logs. O URL tem de ser HTTPS. O timeout opcional `CLOUD_RUN_TIMEOUT_MS` aceita 1 a 120000 ms e usa 15000 ms por omissão.

O limite global de chamadas Google usa `GOOGLE_DAILY_LIMIT` (600 por omissão, máximo configurável 1440) e é contado por data UTC na tabela `google_daily_usage`, criada pela migração local `0005_google_daily_usage.sql`. Cada reserva é uma UPSERT atómica anterior à chamada externa; respostas HTTP de erro, timeouts e erros de rede também consomem uma unidade. Ao esgotar a quota, a verificação fica `pending`, o lease é libertado sem actualizar `last_checked_at` e a monitorização automática fica por executar até ao próximo dia UTC. O scheduler faz uma leitura preventiva para não adquirir leases repetidamente durante o resto do dia.

Esta alteração apenas prepara o código e a configuração local predefinida. Não configura secrets/variáveis numa conta Cloudflare nem publica qualquer Worker.
