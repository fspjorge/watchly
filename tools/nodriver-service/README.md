# Watchly JavaScript Renderer (protótipo independente)

Serviço separado do Worker Watchly. Renderiza páginas HTTPS autorizadas num Chromium descartável, controlado por nodriver. Não grava snapshots nem tem bindings à D1.

## API

- `GET /health` — responde `{"status":"ok"}`; não inicia o Chromium nem faz pedidos externos.
- `POST /render` — exige `Authorization: Bearer <RENDER_API_TOKEN>` e JSON `{"url":"https://..."}`.

Exemplo de resposta:

```json
{
  "status": "rendered",
  "blocked_reason": null,
  "title": "Título da página",
  "final_url": "https://www.worten.pt/...",
  "html": "<html>...</html>",
  "text": "Texto visível...",
  "content_bytes": 12345,
  "http_status": 200,
  "metrics": {"duration_ms": 1800, "proxy_blocked_requests": 0}
}
```

`status` pode ser `rendered` ou `blocked`. O estado `blocked` distingue `challenge` (marcadores de verificação/CAPTCHA ou HTTP 403/429 da origem) de `network_policy` (recurso para domínio não autorizado ou destino bloqueado). O serviço não tenta resolver desafios nem contornar bloqueios. Em HTTP 401, 403, 413, 502 e 504, a resposta tem um código de erro estruturado. Erros e logs não incluem o token, corpo HTML, query string nem o URL completo.

O limite predefinido do conteúdo devolvido é 2 MiB. O limite de tempo total é 45 segundos. `GET /health` não é um health check do site alvo.

## Protecção de rede

O URL inicial precisa de ser HTTPS e o host precisa de corresponder a `ALLOWED_DOMAINS` (exactamente ou como subdomínio). O valor inicial é `worten.pt`; isto permite o host de referência `www.worten.pt`. URLs com credenciais, IP literal, portas diferentes de 443, localhost, endereços privados/reservados e hosts fora da allowlist são rejeitados.

O Chromium recebe todas as ligações HTTPS através de um proxy local descartável. O proxy resolve A/AAAA para cada `CONNECT`, rejeita o conjunto inteiro se algum endereço não for globalmente público e liga por um IP numérico validado. Assim, a resolução posterior não escolhe o IP da ligação. Cada redirect/subdomínio gera uma nova validação antes do próximo socket. O túnel TLS continua a ser negociado pelo Chromium para o hostname original, mantendo SNI e validação normal do certificado. O proxy não aceita ligações a endereços privados nem é um proxy público.

O proxy-bypass implícito de loopback é removido; QUIC é desactivado, DNS do Chromium é bloqueado e WebRTC não pode usar UDP fora do proxy. O serviço não usa User-Agent personalizado, modo `expert`, helpers de CAPTCHA, stealth plugins, proxies externos nem cookies persistentes. Cada pedido usa perfil Chromium temporário e remove-o ao terminar.

O controlo cobre o tráfego HTTP(S) do Chromium no caminho do proxy. Não há firewall de saída/VPC configurada nesta etapa; por isso, esta implementação não deve ser considerada uma fronteira de rede ao nível do sistema operativo. Antes de um uso de produção com URLs mais amplos, repetir a revisão de egress no ambiente Cloud Run e manter a allowlist mínima. Recursos legítimos em domínios externos a `worten.pt` serão bloqueados; acrescenta-os um a um a `ALLOWED_DOMAINS` apenas após autorização.

## Execução local no Windows

Requer Python 3.12 (nodriver requer Python >=3.9) e Chromium/Chrome instalado. O token deve ser temporário e fornecido apenas no ambiente do processo.

```powershell
cd tools/nodriver-service
py -3.12 -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
$token = [Convert]::ToBase64String([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
$env:RENDER_API_TOKEN = $token
$env:ALLOWED_DOMAINS = "worten.pt"
$env:CHROME_BIN = "C:\Program Files\Google\Chrome\Application\chrome.exe"
$env:PORT = "8080"
$server = Start-Process -FilePath python -ArgumentList "app.py" -WorkingDirectory (Get-Location) -PassThru -WindowStyle Hidden
try {
    $deadline = (Get-Date).AddSeconds(15)
    $health = $null
    do {
        try { $health = Invoke-RestMethod http://127.0.0.1:8080/health; break }
        catch { Start-Sleep -Milliseconds 250 }
    } while ((Get-Date) -lt $deadline)
    if (-not $health) { throw "O serviço não arrancou dentro de 15 segundos." }
    $body = @{ url = "https://www.worten.pt/produtos/maquina-de-cafe-philips-ep3241-50-s3200-pr-outlet-grade-a-15-bar-12-niveis-de-moagem-7652626" } | ConvertTo-Json -Compress
    Invoke-RestMethod -Method Post -Uri http://127.0.0.1:8080/render -Headers @{ Authorization = "Bearer $token" } -ContentType "application/json" -Body $body
} finally {
    if ($server -and -not $server.HasExited) { Stop-Process -Id $server.Id -Force }
    Remove-Item Env:RENDER_API_TOKEN,Env:PORT,Env:ALLOWED_DOMAINS,Env:CHROME_BIN -ErrorAction SilentlyContinue
    $token = $null
}
```

O teste mantém o token apenas na memória do PowerShell e no ambiente do processo filho, não o imprime nem o grava. Não coloques o token em `app.py`, `.env.example`, Git ou logs. O `.env.example` é apenas uma lista de nomes e valores de configuração não secretos. Os testes automatizados não dependem de sites ou DNS públicos.

### Testes locais

```powershell
python -m pip install -r requirements-test.txt
python -m pytest -q
```

Os testes automatizados simulam nodriver e DNS, incluindo a integração do proxy com o conector fixado. O teste real do Chromium e da página Worten é manual usando os comandos acima; não contorna uma eventual página 403/CAPTCHA.

## Docker local

```powershell
docker build -t watchly-nodriver-render .
$env:RENDER_API_TOKEN = "<token temporário>"
docker run --rm -p 8080:8080 -e RENDER_API_TOKEN -e ALLOWED_DOMAINS=worten.pt watchly-nodriver-render
```

O container inicia a API directamente com `python app.py`; o processo Python é PID 1 e recebe os sinais de encerramento do Docker. No container, `BROWSER_HEADLESS=true` usa o modo headless suportado pelo nodriver, sem Xvfb nem dependência de `DISPLAY`. Localmente, o modo headful continua a ser o padrão. O Chromium mantém o sandbox activo, sem alterações personalizadas de User-Agent, modo expert, stealth ou mecanismos de contorno de desafios.

## Preparação futura para Cloud Run (não executada)

Antes da publicação, criar um Secret Manager secret para `RENDER_API_TOKEN` e guardar o token por um canal seguro. Não passar o token como argumento de comando nem o incluir em `--set-env-vars`.

Exemplo de publicação para execução futura, a partir desta pasta e depois de escolher/confirmar o projecto:

```powershell
gcloud run deploy watchly-nodriver-render `
  --source . `
  --project <PROJECT_ID> `
  --region europe-southwest1 `
  --cpu 1 `
  --memory 2Gi `
  --min 0 `
  --max 1 `
  --concurrency 1 `
  --timeout 60 `
  --cpu-throttling `
  --allow-unauthenticated `
  --set-env-vars ALLOWED_DOMAINS=worten.pt,RENDER_TIMEOUT_SECONDS=45,MAX_CONTENT_BYTES=2097152 `
  --set-secrets RENDER_API_TOKEN=watchly-render-token:latest
```

Não execute este comando sem decidir antes o acesso público/IAM, o Secret Manager, o projecto e a faturação. `--allow-unauthenticated` torna o endpoint alcançável na rede pública; a API continua a rejeitar pedidos sem Bearer token, mas esses pedidos chegam ao container e podem gerar custo. Máximo de uma instância, concorrência 1 e mínimo zero limitam o paralelismo e mantêm scale-to-zero, mas não impõem um teto de facturação.

### Estimativa de custos

Com 400 chamadas/dia são cerca de 12.000 pedidos/mês, muito abaixo dos 2 milhões de pedidos incluídos no nível gratuito de request-based billing. Com 1 vCPU e 2 GiB, os limites gratuitos publicados são 180.000 vCPU-segundos e 360.000 GiB-segundos por mês. A 12.000 pedidos, estes dois orçamentos correspondem a cerca de **15 segundos médios por pedido** cada (incluindo o arredondamento/billing de instâncias, arranque e encerramento). A 10 s médios: aproximadamente 120.000 vCPU-s e 240.000 GiB-s, abaixo dos limites. A 30 s médios: aproximadamente 360.000 vCPU-s e 720.000 GiB-s, excedendo ambos os limites; com as tarifas Tier 1 publicadas, a ordem de grandeza do excesso de compute seria cerca de **US$5,22/mês**, antes de rede e outros recursos. O Free Tier é agregado à conta de facturação e pode já estar parcialmente consumido por outros projectos.

Tráfego de saída é separado do compute. Uma resposta média de 512 KiB em 12.000 chamadas equivale a cerca de 5,9 GiB/mês; no limite de 2 MiB, cerca de 23,4 GiB/mês. O download das páginas alvo entra no Cloud Run; o HTML/texto que o serviço devolve é tráfego de saída e pode ser cobrado. A franquia de 1 GiB de saída de Cloud Run é para tráfego dentro da América do Norte, não para Madrid/Portugal, pelo que o custo real depende do destino e da tarifa de rede vigente.

Na consola Google Cloud, criar um orçamento mensal com alertas (por exemplo 50%, 80%, 100%) para o projecto. Alertas de orçamento não são um limite rígido nem param automaticamente o serviço. Para controlar consumo operacionalmente, manter a autenticação forte, `max instances=1`, concurrency 1, timeout, limite de conteúdo, allowlist e monitorização de custos; os pedidos HTTP 401 continuam a poder consumir recursos porque chegam à aplicação.

## Dependência e licença

O projeto nodriver declara licença AGPL-3.0 no upstream. Antes de distribuir ou operar este serviço, avaliar a compatibilidade da licença com a forma de utilização do Watchly. [Repositório oficial nodriver](https://github.com/ultrafunkamsterdam/nodriver).
