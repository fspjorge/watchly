# Pressupostos de produção Cloudflare

## Plano e limites assumidos

- Plano: **Workers Free exclusivamente**. Não activar Workers Paid nem assumir custos adicionais.
- Um Cron Trigger global: `* * * * *` (uma invocação por minuto).
- Limites Free relevantes: **10 ms de CPU por invocação Cron ou HTTP**, **100.000 pedidos Worker por dia** e **50 subrequests por invocação**. A Cloudflare pode tolerar ocasionalmente CPU acima de 10 ms, mas invocações que excedem o limite podem terminar com erro 1102; essa tolerância não é orçamento utilizável nem garantia.
- Espera por `fetch` ou D1 aumenta o tempo decorrido, mas não consome CPU enquanto o Worker está suspenso à espera. O processamento JavaScript, HTML, hashing, autenticação e serialização conta para CPU.
- O Cron representa até 1.440 pedidos por dia (1,44% do plafond diário), antes dos pedidos HTTP da aplicação. O plafond é partilhado com os restantes pedidos do Worker.

Fontes: [limites Workers](https://developers.cloudflare.com/workers/platform/limits/), [preços Workers](https://developers.cloudflare.com/workers/platform/pricing/).

## Capacidade do agendador e fila

`MAX_CHECKS_PER_CRON = 1` permite seleccionar no máximo um monitor vencido por invocação. Como a invocação está agendada uma vez por minuto, a capacidade de planeamento é de **até 60 verificações por hora, 1.440 por dia ou 43.200 por mês de 30 dias**, desde que cada execução consiga concluir a verificação e que não haja invocações perdidas ou erros. É uma estimativa de capacidade, não uma garantia de throughput.

| Frequência configurada | Verificações necessárias por monitor/hora | Monitores sustentáveis aproximados |
| --- | ---: | ---: |
| 15 minutos | 4 | 15 |
| 30 minutos | 2 | 30 |
| 1 hora | 1 | 60 |
| 6 horas | 1/6 | 360 |
| 12 horas | 1/12 | 720 |
| 24 horas | 1/24 | 1.440 |

Estes valores assumem carga uniforme, uma invocação útil por minuto e verificações concluídas dentro dos 10 ms de CPU. Uma frequência de 15 minutos exige quatro verificações por monitor/hora; a capacidade teórica não demonstra que o scraper cabe no limite. A activação agenda uma verificação imediata, pelo que um lote de novas activações também pode criar fila inicial.

Quando há mais monitores vencidos do que capacidade, cada invocação trata no máximo um. Os restantes mantêm `next_check_at` vencido e aguardam invocações seguintes. O selector ordena pela hora agendada mais antiga e depois pelo ID, dando prioridade às verificações mais atrasadas. Um lease válido exclui o monitor até libertação ou expiração; um erro interno apanhado pelo código aplica backoff de 120 segundos. Um erro 1102 termina a execução antes de `catch`/`finally`; o lease não é libertado pelo JavaScript e expira em 180 segundos. Para evitar que o mesmo monitor monopolize a fila, a aquisição Cron avança atomicamente `next_check_at` para o ciclo seguinte; uma verificação concluída volta a calcular o próximo ciclo a partir da conclusão. Se o conteúdo continuar a exceder CPU, o monitor falha novamente no ciclo seguinte, mas não é retentado a cada expiração do lease.

### Como identificar atrasos

Para cada monitor activo, o atraso actual é `agora - next_check_at` quando `next_check_at` é anterior a agora. A contagem vencida e a idade do mais antigo podem ser consultadas na D1 com uma consulta apenas de leitura:

```sql
SELECT
  COUNT(*) AS overdue_monitors,
  MAX(CAST(strftime('%s', 'now') AS INTEGER) - next_check_at) AS oldest_overdue_seconds
FROM monitors
WHERE frequency_minutes IS NOT NULL
  AND user_id IS NOT NULL
  AND next_check_at IS NOT NULL
  AND next_check_at <= CAST(strftime('%s', 'now') AS INTEGER);
```

Os logs actuais do Cron incluem `inspected`, `checked`, `errors`, `backoff` e `wallMs`, mas não calculam directamente a idade da fila. Para diagnóstico, acompanhar o crescimento de `overdue_monitors` e `oldest_overdue_seconds` juntamente com esses logs. `wallMs` é tempo decorrido e não substitui a métrica de CPU dos logs/analytics Cloudflare. O GraphQL `workersInvocationsAdaptive` disponibiliza CPU em quantis, mas agrega invocações do Worker e não identifica rota/evento; `workersInvocationsScheduled` permite isolar Cron. Os Workers Trace Events expõem CPU e tipo de evento quando a recolha correspondente está configurada.

## CPU, tamanho de página e viabilidade Free

Antes desta optimização, `MAX_BODY_BYTES` era 2.000.000 (2 MB), demasiado permissivo para o orçamento Free. O limite local actual é 64 KiB: `Content-Length` permite rejeição antecipada, mas a protecção efectiva verifica bytes descodificados em cada chunk do `ReadableStream` e cancela a leitura assim que ultrapassa o máximo. O corpo completo não é materializado antes da verificação e chunks aprovados são unidos uma só vez.

Os dados GraphQL consultados para a versão de produção existente antes destas alterações locais abrangem 109 pedidos agregados em 79 grupos, com zero erros observados. Aproximadamente 20 pedidos estão representados em grupos cujo P50 ou P99 de CPU ultrapassa 10 ms; o maior P50 observado foi 39,285 ms e o maior P99 61,808 ms. O dataset é adaptativamente amostrado e não fornece caminho/rota; por isso, estes valores não podem ser atribuídos com rigor a verificações manuais bem-sucedidas. O dataset de Cron não tinha invocações no intervalo consultado, logo não há medição de CPU do agendador ou da recolha agendada. Estes resultados impedem assumir que a versão de produção cabe sempre nos 10 ms, mas não quantificam isoladamente `fetchPage`/HTML/hash/D1 nem validam a versão optimizada localmente.

### Optimizações aplicadas e validação pendente

1. O extractor foi alterado para um scanner linear de uma passagem, com a mesma remoção de comentários, tags e conteúdo não visível e as mesmas quebras de bloco cobertas pelos testes. A descodificação de entidades passou a uma única substituição; a normalização duplicada em `performCheck` foi removida.
2. O resultado demasiado grande gera erro explícito em vez de truncar silenciosamente. Isto evita que texto depois do limite deixe de ser comparado sem aviso, mas páginas acima de 64 KiB deixam de ser monitorizáveis.
3. O Cron recupera leases expirados por uma actualização condicional e atómica, incrementa `consecutive_lease_failures` e agenda backoff exponencial (120 s inicial, máximo 24 h). Uma conclusão normal repõe o contador a zero. O `next_check_at` é avançado na aquisição, pelo que uma execução terminada por 1102 não deixa o monitor vencido a ocupar continuamente o primeiro lugar da fila. A migração 0004 é necessária no ambiente que receber esta versão; não foi aplicada remotamente.
4. Ainda falta medir separadamente CPU do Cron sem monitor vencido, Cron com páginas pequenas e perto do limite, e endpoint manual, em runtime Cloudflare. `Date.now()` e `wallMs` locais não medem CPU. Sem executar um probe num Worker de teste não é possível obter essa medição real; o probe não foi executado para respeitar a restrição de não fazer deploy.

O limite local de 64 KiB e o scanner linear reduzem o trabalho máximo esperado, mas não demonstram CPU inferior a 10 ms. A qualidade sofre porque páginas maiores são rejeitadas, e HTML pequeno mas patologicamente complexo ainda pode custar mais do que conteúdo simples. Workers Free não garante conclusão para qualquer HTML arbitrário; a viabilidade depende de medir p95/p99 real no runtime Cloudflare antes de activar o Cron.
