# Plano de publicação: Watchly no Cloud Run e Worker

**Estado deste documento:** plano apenas. Nenhum comando `gcloud` ou Wrangler remoto foi executado; não foi criada infraestrutura nem aplicada migração.

## Configuração real encontrada no repositório

| Componente | Valor actual |
| --- | --- |
| Worker | `watchly`, definido em `wrangler.jsonc` |
| Ambiente Wrangler | Ambiente predefinido/top-level; não existe `env.production` |
| D1 | Base `watchly-db`; binding `watchly_db`; ID `700085c7-eda2-42d4-9172-c128fd98a56a` |
| Pasta de migrations | `migrations/` (predefinição Wrangler) |
| Cloud Run | Ainda não existe serviço nem URL conhecida |
| Container | Não existe `Dockerfile`; há `package-lock.json` e o script npm `cloud-run` |
| Projecto Google Cloud | `watchly-514121` |
| Identidade de build | `watchly-builder@watchly-514121.iam.gserviceaccount.com`; `roles/run.builder` atribuído no projecto |
| Identidade runtime | `watchly-runner@watchly-514121.iam.gserviceaccount.com`; usada pelo serviço Cloud Run |
| Segredo HMAC Cloud Run | `watchly-hmac-secret`, versão `2`; acesso concedido a `watchly-runner` |
| Selecção actual | `CHECK_ENGINE=cloudflare`; manter assim durante toda esta preparação |
| Limite actual configurado | `GOOGLE_DAILY_LIMIT=600`; o código mantém 600 como valor predefinido |

O serviço deve chamar-se **`watchly-check`** e a região proposta é **`europe-southwest1` (Madrid)**. Estes são nomes propostos para criação futura, não recursos existentes. O URL só será conhecido depois da primeira publicação.

## 1. Preparar Google Cloud e faturação

O projecto de destino é `watchly-514121`. Confirmar manualmente que a conta de facturação correcta está associada. Se alguma API ainda não estiver activa, a consola pode solicitar a activação; não a aceitar sem confirmar projecto e facturação:

```powershell
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com secretmanager.googleapis.com --project watchly-514121
```

As identidades já criadas para esta configuração têm funções separadas:

| Identidade | Utilização | Permissões necessárias |
| --- | --- | --- |
| `watchly-builder@watchly-514121.iam.gserviceaccount.com` | Executa o build do código-fonte no Cloud Build; indicada por `--build-service-account` | `roles/run.builder` no projecto `watchly-514121` (já atribuída, conforme indicado) |
| `watchly-runner@watchly-514121.iam.gserviceaccount.com` | Identidade de execução do serviço Cloud Run; indicada por `--service-account` | Acesso `roles/secretmanager.secretAccessor` ao segredo `watchly-hmac-secret` (concedido, conforme indicado) |

Não confundir a identidade de build com a identidade runtime nem conceder ao builder acesso ao segredo HMAC sem necessidade.

O segredo `watchly-hmac-secret` usa a **versão 2** nesta publicação. Não incluir o seu valor em argumentos, ficheiros versionados ou logs. A permissão da identidade runtime é limitada ao recurso do segredo:

```powershell
gcloud secrets add-iam-policy-binding watchly-hmac-secret --project watchly-514121 --member "serviceAccount:watchly-runner@watchly-514121.iam.gserviceaccount.com" --role roles/secretmanager.secretAccessor
```

Usar exactamente o mesmo valor, introduzido interactivamente, no secret `WATCHLY_HMAC_SECRET` do Worker. Não reutilizar esse valor para outros serviços.

### Permissões da identidade que executa o deployment

A identidade humana ou CI que executar `gcloud run deploy` precisa de:

- `roles/run.sourceDeveloper` no projecto `watchly-514121`;
- `roles/serviceusage.serviceUsageConsumer` no projecto `watchly-514121`;
- `roles/iam.serviceAccountUser` (`iam.serviceAccounts.actAs`) na identidade runtime `watchly-runner`, para a associar ao serviço.

O executor não precisa de `roles/run.builder`: essa função pertence à identidade de build `watchly-builder`. Como as identidades já existem, o executor não precisa de criar service accounts para executar o comando descrito. Se também lhe for pedido activar APIs, é necessária separadamente a permissão `serviceusage.services.enable` (por exemplo, através de `roles/serviceusage.serviceUsageAdmin`); caso contrário, confirmar que as APIs necessárias já estão activas. Rever eventuais políticas organizacionais antes da execução.

## 2. Build e publicação do serviço Cloud Run

O build por source usa Cloud Build e Buildpacks a partir da **raiz do repositório**; não há Dockerfile nem imagem preparada. O comando de arranque existente é `npm run cloud-run`, executado com Node.js 24, que suporta o `--experimental-strip-types` usado pelo script. Localmente, a validação prévia é:

O `.gcloudignore` na raiz reutiliza as regras existentes de `.gitignore` através de `#!include:.gitignore` e usa uma allowlist: `package.json`, `package-lock.json` e os módulos `.ts` alcançáveis pelo grafo de imports do servidor. O grafo runtime inspeccionado é:

```text
cloud-run/server.ts
└─ cloud-run/http.ts
   └─ cloud-run/check.ts
      ├─ cloud-run/ssrf.ts
      │  └─ cloud-run/redirects.internal.ts
      ├─ worker/extract.ts
      └─ worker/api.ts
         ├─ worker/diff.ts
         ├─ worker/extract.ts
         ├─ worker/scrape.ts
         ├─ worker/scheduling.ts
         ├─ worker/googleCheck.ts
         └─ worker/googleQuota.ts
```

Os imports de `Queryable` e `UserRecord` são `import type`, removidos pelo runtime Node; `worker/db.ts` e `worker/auth.ts` não são dependências runtime do serviço. Também ficam fora `worker/env.d.ts`, `worker/index.ts`, `worker/scheduler.ts` e `worker/testSupport.ts`, que não pertencem ao grafo de runtime. O filtro default-deny exclui frontend, configurações Vite/Vitest/TypeScript, testes, PowerShell de desenvolvimento, Markdown, migrations, `.git/`, `.superpowers/` e fixtures. Há também exclusões explícitas para chaves, certificados TLS e ficheiros `.secret` em qualquer pasta. Os módulos de runtime acima são reintroduzidos individualmente; não se exclui `worker/` como um todo. Não alterar `.gitignore`.

Antes de cada publicação a partir da raiz, inspeccionar localmente a lista com:

```powershell
gcloud meta list-files-for-upload
```

Confirmar que não aparecem `ca-key.pem`, `server-key.pem`, `wrong-host-key.pem`, `ca.pem`, `server.pem`, `wrong-host.pem` nem qualquer caminho `cloud-run/fixtures/`. Esta inspecção não publica nem cria recursos.

Na última verificação local, `gcloud meta list-files-for-upload` apresentou exactamente os 14 ficheiros permitidos pela allowlist. Repetir a inspecção se o contexto de publicação ou o `.gcloudignore` mudar.

```powershell
npm test
npm run build
npm run lint
npm run cloud-run
```

Para a publicação futura, o comando abaixo configura 1 vCPU, 512 MiB, billing baseado em pedidos, zero instâncias mínimas, uma instância máxima, concorrência 1 e timeout de 30 segundos. `--port=8080` fornece a variável `PORT` já suportada pelo servidor. `--cpu-throttling` mantém alocação de CPU baseada em pedidos; `--no-cpu-boost` evita o boost de arranque. O serviço fica publicamente endereçável porque o Worker não envia identidade IAM para Cloud Run; o endpoint `/v1/check` continua protegido pela autenticação HMAC da aplicação. `/health` será público.

```powershell
gcloud run deploy watchly-check `
  --source . `
  --region europe-southwest1 `
  --project watchly-514121 `
  --build-service-account=projects/watchly-514121/serviceAccounts/watchly-builder@watchly-514121.iam.gserviceaccount.com `
  --base-image nodejs24 `
  --command npm `
  --args run,cloud-run `
  --cpu 1 `
  --memory 512Mi `
  --cpu-throttling `
  --no-cpu-boost `
  --min 0 `
  --max 1 `
  --concurrency 1 `
  --timeout 30s `
  --port 8080 `
  --service-account watchly-runner@watchly-514121.iam.gserviceaccount.com `
  --set-secrets WATCHLY_HMAC_SECRET=watchly-hmac-secret:2 `
  --allow-unauthenticated
```

O timeout interno de recolha existente no serviço é 8 segundos. No Worker, `CLOUD_RUN_TIMEOUT_MS` aceita 1–120000 ms e usa 15000 ms por omissão; manter o timeout do Worker em 15000 ms e o do serviço em 30 s deixa margem para o Worker cancelar primeiro. Cloud Run pode continuar a processar por algum tempo depois de o cliente cortar a ligação, por isso não configurar retries automáticos.

O binding `WATCHLY_HMAC_SECRET=watchly-hmac-secret:2` fixa explicitamente a versão 2 do Secret Manager. A rotação não actualiza esta revisão automaticamente: criar a nova versão, actualizar também o secret do Worker e publicar uma revisão Cloud Run que referencie a mesma versão, coordenando a troca para evitar indisponibilidade. Não assumir que adicionar uma versão ao Secret Manager roda o valor em execução.

### Modelo de acesso: HMAC público ou IAM/OIDC

O comando acima inclui `--allow-unauthenticated`: o URL Cloud Run é público e tanto `/health` como `/v1/check` chegam ao serviço. A aplicação protege `/v1/check` com HMAC SHA-256 e devolve 401 quando a assinatura não é válida. Isto é uma barreira de autenticação da aplicação, não uma restrição de invocação Cloud Run.

No fluxo pretendido, HMAC é uma solução praticável se o segredo for aleatório e forte, guardado apenas no Secret Manager e no secret do Worker, transmitido por TLS e rodado em caso de exposição. A assinatura cobre timestamp e bytes exactos do corpo, com janela de cinco minutos e comparação em tempo constante. A janela não impede replay do mesmo pedido dentro desses cinco minutos. Um segredo comprometido permite invocar o serviço directamente e contornar completamente o contador diário D1, que só é aplicado pelo Worker.

Pedidos com HMAC inválido que recebam 401 **são processados pelo container** nesta configuração pública e podem consumir CPU/memória e tempo de instância facturável; podem também ocupar a única instância e atrasar pedidos legítimos. A regra de preços que exclui pedidos rejeitados por IAM não se aplica a estes 401 da aplicação. `--max 1` limita instâncias simultâneas, não o volume total de pedidos nem o custo acumulado. O Free Tier pode absorver parte do uso, mas não constitui protecção contra indisponibilidade nem um tecto de custo.

Alternativa mais forte: exigir IAM no Cloud Run, removendo `--allow-unauthenticated` (e qualquer concessão `allUsers` de `roles/run.invoker`), e conceder `roles/run.invoker` apenas à identidade chamadora. O chamador tem de enviar um ID token OIDC assinado pela Google com `aud` igual ao URL do serviço; pedidos negados por IAM não são facturados como pedidos de container pela tabela de preços.

Isto não é uma configuração pronta para o Worker actual. Google documenta Workload Identity Federation para workloads fora da Google Cloud, mas é necessário que o chamador obtenha um token OIDC externo confiável, troque-o por credenciais federadas e peça um ID token para o serviço. O Worker neste checkout só implementa HMAC e não dispõe de uma identidade de workload Google nem de um token OIDC de plataforma configurado para essa federação. Uma alternativa tecnicamente possível seria manter uma chave de service account no Worker e assinar/trocar JWTs, mas essa chave longa e de alto impacto aumenta o risco e a carga de rotação; não é recomendada como simples melhoria. IAM/WIF exige desenho e implementação próprios antes de remover HMAC ou tornar o serviço privado. Para a preparação descrita neste documento, o compromisso explícito é URL público + HMAC, com risco residual de pedidos 401 e de abuso se o segredo vazar.

Depois da publicação, obter o URL sem o adivinhar:

```powershell
gcloud run services describe watchly-check --region europe-southwest1 --project watchly-514121 --format="value(status.url)"
```

### Confirmar health e HMAC

`GET /health` deve devolver HTTP 200 e `{"status":"ok"}`:

```powershell
curl.exe --fail --silent --show-error https://<URL_DO_SERVICO>/health
```

Depois de uma publicação bem-sucedida da revisão `watchly-check`, o smoke test remoto pode confirmar `/health`, um pedido `/v1/check` assinado e a rejeição de uma assinatura inválida. A identidade `gcloud` local precisa de `secretmanager.versions.access` no segredo. O script usa o URL e o segredo configurados para este serviço e não deve ser executado durante a preparação local:

```powershell
.\cloud-run\remote-smoke-test.ps1
```

O script lê `watchly-hmac-secret` versão 2 do projecto `watchly-514121`, mantém o valor apenas em memória e não imprime nem persiste o segredo ou as assinaturas. O pedido válido pode devolver `outcome: "error"` se a recolha do site monitorizado falhar; desde que o serviço aceite a HMAC e devolva HTTP 200 com a resposta estruturada, isso é distinto de falha de autenticação. A assinatura inválida tem de devolver HTTP 401.

Para demonstrar HMAC, fazer um único `POST /v1/check` directo para `https://example.com/`, com timestamp Unix em segundos e assinatura HMAC-SHA256 dos bytes exactos `timestamp + LF + UTF-8(JSON)`. Usar o segredo através de prompt seguro e imprimir apenas status/outcome, nunca segredo ou assinatura. Esperar HTTP 200 e um JSON com `outcome`, `content`, `contentHash`, `httpStatus`, `contentType` e `metrics`; uma assinatura deliberadamente inválida deve receber HTTP 401. Este pedido directo não passa pelo Worker e, por isso, não consome o contador diário D1; ainda assim, consome recursos do Cloud Run e deve limitar-se a uma amostra.

## 3. Confirmar e preparar Cloudflare D1

O alvo correcto, conforme o binding versionado, é **`watchly-db`**, ID **`700085c7-eda2-42d4-9172-c128fd98a56a`**, binding **`watchly_db`**. Confirmar conta/perfil e identidade do banco antes de qualquer comando remoto:

```powershell
npx wrangler d1 info watchly-db --json --config wrangler.jsonc
npx wrangler d1 migrations list watchly-db --remote --config wrangler.jsonc
```

O estado remoto não foi consultado nesta preparação. O comando `migrations apply` aplica **todas** as migrations locais ainda pendentes, não permite escolher apenas a 0005. Só prosseguir quando a lista confirmar que 0001–0004 já estão aplicadas e que a única pendente é `0005_google_daily_usage.sql`. Se aparecer qualquer outra pendência, parar e rever o plano antes de aplicar.

Quando essa condição estiver verificada, o comando futuro é:

```powershell
npx wrangler d1 migrations apply watchly-db --remote --config wrangler.jsonc
```

Confirmar a lista de migrations depois da aplicação e consultar o registo e a tabela:

```powershell
npx wrangler d1 migrations list watchly-db --remote --config wrangler.jsonc
npx wrangler d1 execute watchly-db --remote --config wrangler.jsonc --command "SELECT name FROM d1_migrations WHERE name = '0005_google_daily_usage.sql';"
npx wrangler d1 execute watchly-db --remote --config wrangler.jsonc --command "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'google_daily_usage';"
```

Esperar uma linha `0005_google_daily_usage.sql` no histórico e uma linha `google_daily_usage` no schema. A tabela deve começar sem linhas; a migration não altera monitores nem snapshots existentes.

## 4. Preparar variáveis e segredo do Worker

O `wrangler.jsonc` é actualmente a fonte de verdade para o ambiente predefinido do Worker `watchly`; não existe um ambiente Wrangler separado `production`. Não usar `--env production` sem primeiro criar deliberadamente esse ambiente: seria um alvo distinto. Wrangler substitui no próximo deploy as variáveis configuradas apenas pelo Dashboard.

Depois de obter o URL real do serviço, preparar no bloco `vars` do ambiente predefinido estes valores para a publicação de preparação:

```jsonc
"CHECK_ENGINE": "cloudflare",
"CLOUD_RUN_URL": "https://<URL_DO_SERVICO>",
"CLOUD_RUN_TIMEOUT_MS": "15000",
"GOOGLE_DAILY_LIMIT": "400"
```

O valor `400` é uma configuração inicial deste ambiente, não uma alteração ao valor predefinido `600` no código. **Manter `CHECK_ENGINE` exactamente `cloudflare`** em todo este plano. O URL não é segredo; `WATCHLY_HMAC_SECRET` tem de ser um secret Worker, nunca um `vars` plaintext. Para o Worker actual, o comando futuro usa o ambiente predefinido:

```powershell
npx wrangler secret put WATCHLY_HMAC_SECRET --config wrangler.jsonc
```

Wrangler pede o valor interactivamente e `secret put` publica imediatamente uma versão. Executá-lo apenas depois de confirmar que a configuração local mantém `CHECK_ENGINE=cloudflare` e que os restantes valores estão preparados. Em alternativa, configurar o secret e as variáveis no Dashboard de `Workers & Pages → watchly → Settings → Variables and Secrets`, seleccionar **Production** apenas se esse for o ambiente onde o Worker actual está publicado e publicar as alterações nessa etapa. Não misturar variáveis do Dashboard com deploys Wrangler sem as copiar para o `wrangler.jsonc`.

## 5. Sequência de publicação

1. **Preparar Google Cloud e facturação:** confirmar projecto, billing account, APIs, IAM, identidade dedicada, Secret Manager e alertas de custos.
2. **Criar/publicar Cloud Run:** usar `watchly-check`, `europe-southwest1` e a configuração de recursos acima. Guardar o URL mostrado pela plataforma.
3. **Confirmar health:** verificar `/health` com HTTP 200.
4. **Confirmar HMAC:** fazer um POST válido e um inválido directamente ao serviço; verificar 200 e 401. Limitar o teste válido a uma chamada.
5. **Verificar D1 remota:** confirmar que o nome e UUID correspondem ao `wrangler.jsonc` e ler a lista de migrations remotas.
6. **Aplicar 0005:** apenas se 0001–0004 já estiverem aplicadas e a 0005 for a única pendente; confirmar `d1_migrations` e `google_daily_usage` depois.
7. **Preparar Worker:** colocar o URL e `GOOGLE_DAILY_LIMIT=400` no ambiente predefinido, manter `CHECK_ENGINE=cloudflare`, e preparar o mesmo HMAC secret de forma segura.
8. **Publicar Worker com Cloudflare activo:** `wrangler secret put` cria/deploya uma versão imediatamente. Antes de o executar, confirmar que o `wrangler.jsonc` preparado contém `CHECK_ENGINE=cloudflare` e todos os valores desejados (`CLOUD_RUN_URL`, timeout e limite 400). A publicação feita pelo `secret put` deve ser tratada como o deploy desta etapa; confirmar a configuração publicada e que não houve activação do motor Google.
9. **Verificação antes de qualquer activação Google:** confirmar logs sem segredos, health/HMAC, estado D1, migration, variáveis/secrets, quota configurada em 400 e ausência de erros. Só uma decisão posterior poderá alterar o motor; esta preparação não o faz.
10. **Activação Google — operação separada, não autorizada por este plano:** só após decisão explícita, mudar `CHECK_ENGINE` para `google` no `wrangler.jsonc` e publicar uma nova versão. Não fazer esta alteração durante a preparação.

### Rollback operacional do motor

Se a activação Google causar falhas, rollback imediato do motor: definir `CHECK_ENGINE=cloudflare` no `wrangler.jsonc` e publicar a configuração actual com `npx wrangler deploy --config wrangler.jsonc`. Confirmar no Worker publicado que `CHECK_ENGINE` é `cloudflare` e que as verificações voltaram ao motor Cloudflare. Não depender apenas de `wrangler rollback` para este caso: restaurar uma versão antiga pode também repor código/configuração anteriores. A reversão do motor não reverte a migration 0005 nem apaga dados da tabela diária; isso é intencional e não bloqueia o motor Cloudflare.

## 6. Quotas e custo com 400 pedidos/dia

Valores oficiais consultados em **8 de Novembro de 2026**. O Free Tier Cloud Run para services com request-based billing inclui, agregado na billing account e por mês, **180.000 vCPU-seconds**, **360.000 GiB-seconds de memória** e **2 milhões de pedidos**. Madrid (`europe-southwest1`) está na lista de regiões elegíveis. Cada pedido soma o tempo facturável, arredondado ao décimo de segundo; para request-based billing, o tempo inclui arranque/desligamento facturáveis e o intervalo em que o pedido está a ser processado. O Free Tier pode já estar parcialmente consumido por outros projectos na mesma billing account.

400 verificações/dia equivalem a aproximadamente **12.000 pedidos num mês de 30 dias**. Com 1 vCPU e 0,5 GiB, estimativas simplificadas por duração facturável média:

| Duração facturável média | vCPU-seconds/mês | GiB-seconds/mês | Leitura face ao Free Tier |
| ---: | ---: | ---: | --- |
| 0,5 s | 6.000 | 3.000 | Abaixo dos limites de CPU, memória e pedidos |
| 5 s | 60.000 | 30.000 | Abaixo dos limites de CPU, memória e pedidos |
| 15 s | 180.000 | 90.000 | CPU chega ao limite incluído; arranques/arredondamento podem gerar excesso |
| 30 s | 360.000 | 180.000 | 180.000 vCPU-s acima do limite incluído; a preço Tier 1 actual (~$0,000024/vCPU-s), cerca de **$4,32** de CPU antes de outros custos |

Estas estimativas não são garantias nem incluem os custos de rede, Cloud Build, armazenamento de imagens, Secret Manager, outros serviços na billing account ou variação de preço/câmbio. A tabela oficial de request-based billing mostra também ~$0,0000025/GiB-s para memória activa e $0,40 por milhão de pedidos acima do Free Tier. Com 12.000 pedidos, o componente de pedidos fica muito abaixo dos 2 milhões incluídos.

### Tráfego de saída

O HTML recebido dos sites monitorizados entra no Cloud Run; dados transferidos para dentro da Google Cloud são gratuitos. A resposta normalizada/hash sai do Cloud Run para o Worker e conta como tráfego de saída para a Internet. A página de preços Cloud Run destaca apenas 1 GiB/mês de egress gratuito dentro da América do Norte; não assumir esse benefício para a região de Madrid. O egress Premium Tier para destinos europeus começa actualmente em ~$0,12/GiB.

Como cenário ilustrativo, se cada uma das 12.000 respostas mensais transportasse 2 MiB, seriam cerca de **23,4 GiB/mês**; a ~$0,12/GiB, aproximadamente **$2,81/mês**. O serviço limita o corpo upstream a 2 MiB, mas isto não é uma medição do tamanho médio do JSON de resposta nem um limite formal de bytes egress. Medir o tráfego real após publicação e consultar o destino/região tarifado antes de projectar custo.

### Outros componentes e limites de custo

- Cloud Build inclui actualmente 2.500 build-minutes/mês; source deployments também guardam a imagem em Artifact Registry, cujo Free Tier é 0,5 GiB de armazenamento. Esses produtos são facturados separadamente de Cloud Run.
- Secret Manager inclui 6 versões activas e 10.000 acessos/mês por billing account. Arranques de instância podem originar leituras do secret; rotação de versões activas além do incluído pode ter custo.
- `--max 1`, `--min 0` e concorrência 1 limitam instâncias simultâneas e evitam custo de instância mínima ociosa. **Não limitam o total mensal de chamadas, o volume de egress ou o número de arranques.**
- O `GOOGLE_DAILY_LIMIT=400` é imposto pelo Worker através da D1, contando tentativas Google do fluxo Watchly. Chamadas directas ao URL Cloud Run não passam por esse contador. O serviço público precisa do HMAC; a exposição/compromisso do segredo permite contornar a quota D1.
- Cada pedido público com HMAC inválido alcança o container e pode gerar custo de instância, mesmo recebendo 401; ataques podem ainda consumir capacidade da instância única. A protecção de custo de pedidos negados por IAM só existe se IAM estiver activo e rejeitar o pedido antes do container.
- Criar alertas de orçamento no Cloud Billing, por exemplo em 50%, 80% e 100% do orçamento, e alertas Cloud Monitoring para pedidos, instâncias, latência, erros e `container/billable_instance_time`. Orçamentos e alertas notificam; **não são um tecto rígido de despesa** e podem atrasar-se. A quota D1 também não protege contra chamadas directas autenticadas fora do Worker.
- A quota de aplicação não cobre Cloud Build, Artifact Registry, Secret Manager, rede, impostos, utilização de outros projectos, egress causado por abuso, nem o custo de chamadas que continuem a executar depois de o cliente cancelar. Não há garantia de custo máximo zero pelo Free Tier.

## Intervenções manuais ainda necessárias

1. Confirmar billing, APIs e permissões no projecto `watchly-514121`; confirmar que `watchly-builder` e `watchly-runner` mantêm as funções documentadas e que `watchly-hmac-secret` versão 2 está activa.
2. Preparar `.gcloudignore`, excluir `cloud-run/fixtures/`, inspeccionar a lista de ficheiros de upload e só então rever/executar o build por source e publicar Cloud Run; guardar e testar o URL.
3. Consultar o estado **real** das migrations remotas; só então decidir aplicação da 0005.
4. Preparar as variáveis do Worker e o secret correspondente, sem alterar `CHECK_ENGINE=cloudflare`.
5. Configurar alertas, rever consumo Free Tier/egress e confirmar manualmente cada gate antes de uma futura decisão de activação.
6. Se IAM for escolhido em vez do modelo público HMAC, desenhar e testar primeiro a federação de identidade externa/OIDC do Worker; não remover `--allow-unauthenticated` até existir prova de que o Worker obtém e envia um ID token válido.

## Referências oficiais

- [Cloud Run: deploy from source](https://docs.cloud.google.com/run/docs/deploying-source-code)
- [gcloud run deploy: flags e recursos](https://docs.cloud.google.com/sdk/gcloud/reference/run/deploy)
- [Cloud Run pricing](https://cloud.google.com/run/pricing)
- [Cloud Run request timeout](https://docs.cloud.google.com/run/docs/configuring/request-timeout)
- [Cloud Run secrets e permissões](https://docs.cloud.google.com/run/docs/configuring/services/secrets)
- [Cloud Run source deploy IAM](https://docs.cloud.google.com/run/docs/reference/iam/roles)
- [Configurar build service account para source deploy](https://docs.cloud.google.com/run/docs/configuring/services/build-service-account)
- [Papéis exigidos para deploy a partir de source](https://docs.cloud.google.com/run/docs/deploying-source-code)
- [Cloud Build pricing](https://cloud.google.com/build/pricing)
- [Artifact Registry pricing](https://cloud.google.com/artifact-registry/pricing)
- [Secret Manager pricing](https://cloud.google.com/secret-manager/pricing)
- [Google Cloud network pricing](https://cloud.google.com/vpc/network-pricing)
- [Wrangler D1 commands](https://developers.cloudflare.com/workers/wrangler/commands/d1/)
- [D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/)
- [Wrangler configuration source of truth](https://developers.cloudflare.com/workers/wrangler/configuration/)
- [Cloudflare Worker variables](https://developers.cloudflare.com/workers/configuration/environment-variables/)
- [Cloudflare Worker secrets](https://developers.cloudflare.com/workers/configuration/secrets/)
