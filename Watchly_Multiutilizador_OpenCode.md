# Watchly — Especificação de implementação multiutilizador

**Objectivo:** evoluir o MVP actual do Watchly para uma aplicação multiutilizador, com registo automático através de Google e dados privados por utilizador, preservando integralmente as monitorizações e os snapshots já existentes.

**Instrução para o OpenCode:** lê este documento e inspecciona primeiro o repositório. Implementa a solução por etapas, sem reescrever partes que já funcionam. Não publiques na Cloudflare, não apliques migrações à D1 remota e não alteres as políticas do Cloudflare Access.

---

## 1. Resultado pretendido

Qualquer pessoa que consiga autenticar-se com uma conta Google através do Cloudflare Access poderá utilizar o Watchly. No primeiro acesso, o sistema cria automaticamente o perfil do utilizador.

Cada utilizador deve ter um espaço privado e independente:

- só vê as suas próprias monitorizações;
- só pode adicionar, verificar, editar ou apagar as suas monitorizações;
- só pode consultar os snapshots e as diferenças das suas monitorizações;
- não consegue aceder aos dados de outro utilizador, mesmo que descubra ou adivinhe o identificador de uma monitorização.

Os dados existentes do proprietário inicial têm de ser preservados e associados à conta `fspjorge@gmail.com`. Nenhum outro utilizador pode receber esses dados.

O projecto continua a utilizar uma única base de dados Cloudflare D1. Não criar uma base de dados por utilizador.

## 2. Estado e tecnologias existentes

Antes de alterar código, confirmar a estrutura actual do repositório e ler, pelo menos:

- `package.json`
- `wrangler.jsonc`
- `worker/index.ts`
- `worker/api.ts`
- `worker/scrape.ts`
- `worker/extract.ts`
- `worker/diff.ts`
- `src/api.ts`
- `src/App.tsx`
- `src/components/*`
- `migrations/0001_initial_schema.sql`
- `vitest.config.ts` e testes existentes

Stack actual:

- React 19 + TypeScript + Vite;
- Cloudflare Workers com Static Assets;
- Cloudflare D1 (SQLite), binding `watchly_db`;
- Wrangler;
- Vitest e Oxlint;
- Cloudflare Access como camada de autenticação, com Google como Identity Provider.

Existem actualmente 40 testes aprovados. Preservar esses testes e acrescentar novos.

Rotas REST actualmente existentes:

- `GET /api/monitors`
- `POST /api/monitors`
- `POST /api/monitors/:id/check`
- `GET /api/monitors/:id/diff`

O scraper tem protecção SSRF, validação dos redirects, timeout, limite de tamanho e extracção/normalização de texto. Não enfraquecer nem remover essa implementação.

## 3. Autenticação: Cloudflare Access JWT

### 3.1. Regra fundamental

O Worker não pode confiar em dados de identidade enviados pelo frontend. A identidade deve ser obtida exclusivamente através de um JWT emitido e assinado pelo Cloudflare Access.

Ler o cabeçalho:

`Cf-Access-Jwt-Assertion`

Validar o token no Worker usando a biblioteca `jose` e a Web Crypto API, compatível com Cloudflare Workers.

Usar a chave pública/JWKS do Access em:

`https://<TEAM_DOMAIN>/cdn-cgi/access/certs`

Usar `createRemoteJWKSet` e `jwtVerify` da biblioteca `jose`, ou uma solução equivalente oficialmente compatível com Workers.

Validar obrigatoriamente:

- assinatura criptográfica;
- algoritmo esperado (`RS256`);
- `iss`, exactamente igual ao domínio/team issuer configurado;
- `aud`, incluindo o Application Audience (AUD) da aplicação Watchly;
- `exp` e `nbf`, quando presentes;
- presença de `sub` não vazio;
- presença de `email` válido e não vazio.

Não aceitar tokens sem assinatura válida, com issuer/audience diferente, expirados ou ainda não válidos.

Não confiar em `Cf-Access-Authenticated-User-Email`, no email do body, em query strings, em `localStorage` ou em cabeçalhos arbitrários enviados pelo browser como prova de identidade.

O módulo de autenticação deve devolver um tipo interno, por exemplo `AuthenticatedUserIdentity`, com `subject`, `email` normalizado e `name` quando disponível.

### 3.2. Configuração

Adicionar ao tipo `Env` e documentar as variáveis necessárias:

- `TEAM_DOMAIN`: domínio da organização Cloudflare Access, por exemplo `https://shrill-bush-5ca5.cloudflareaccess.com`;
- `ACCESS_AUD`: Application Audience (AUD) da aplicação Access Watchly;
- `LEGACY_OWNER_EMAIL`: `fspjorge@gmail.com`, utilizado exclusivamente para associar os registos antigos ao proprietário inicial.

Estas variáveis não são segredos, mas devem ser configuradas conscientemente em produção e em desenvolvimento. Não inventar nem adivinhar o valor de `ACCESS_AUD`: indicar onde o obter no painel Access e deixar instruções claras.

Não colocar Client Secret do Google no código, em `wrangler.jsonc`, no Git ou em ficheiros de exemplo. O Client ID/Secret Google já estão configurados no Cloudflare Access; o Worker não deve implementar um segundo fluxo OAuth.

### 3.3. Desenvolvimento local

O servidor local `npm run dev` não recebe automaticamente um JWT do Cloudflare Access. Criar um mecanismo de identidade de desenvolvimento **explicitamente local e fail-closed** para permitir testar duas contas diferentes.

Requisitos:

- activação apenas com uma variável local explícita, por exemplo `DEV_AUTH=true`;
- aceitar esse modo apenas quando o hostname da request é loopback (`localhost` ou `127.0.0.1`);
- nunca permitir que um valor enviado pelo browser active o modo de desenvolvimento;
- não definir `DEV_AUTH=true` em configurações de produção;
- incluir `.dev.vars.example` sem credenciais reais e confirmar que `.dev.vars` está no `.gitignore`;
- permitir definir localmente duas identidades de teste (por exemplo, `dev-user-a@example.test` e `dev-user-b@example.test`) e alternar entre elas de forma explícita para testar isolamento;
- se o modo local não estiver explicitamente activado, exigir JWT tal como em produção.

Não criar qualquer fallback permissivo em produção.

## 4. Modelo de dados e migração

Criar uma nova migração:

`migrations/0002_multiuser_ownership.sql`

**Não alterar nem reescrever `0001_initial_schema.sql`.** As migrações aplicadas são imutáveis.

### 4.1. Tabela `users`

Criar uma tabela com, pelo menos:

- `id TEXT PRIMARY KEY` — UUID interno gerado pelo servidor;
- `auth_subject TEXT NOT NULL UNIQUE` — claim `sub` validada do Access JWT;
- `email TEXT NOT NULL`;
- `name TEXT`;
- `created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP`;
- `last_login_at TEXT`.

Criar um índice para pesquisa de email sem distinção entre maiúsculas/minúsculas. Não usar o email enviado pelo frontend como chave de identidade.

O `auth_subject` é a chave principal para reconhecer a identidade autenticada. Não fazer associação automática de contas diferentes apenas porque apresentam o mesmo email, salvo o processo controlado de recuperação dos dados antigos descrito na secção 4.3.

### 4.2. Alterações às tabelas existentes

Adicionar `user_id` à tabela `monitors`, com referência a `users(id)`. Como os registos antigos ainda não têm proprietário, a coluna pode ser temporariamente nullable na migração. A aplicação deve, contudo, exigir sempre um `user_id` válido na criação de novas monitorizações e nunca devolver registos com `user_id IS NULL` a utilizadores normais.

Adicionar `source_url` à tabela `snapshots`.

Preencher `source_url` nos snapshots existentes com o URL actual da respectiva monitorização, através de um `UPDATE` baseado em `monitor_id`.

Criar índices apropriados, pelo menos:

- `monitors(user_id, created_at)`;
- `snapshots(monitor_id, source_url, captured_at)` ou índice equivalente que suporte a consulta das versões da monitorização e do URL actual.

Não apagar nem modificar o conteúdo, hash, datas ou identificadores dos snapshots existentes.

### 4.3. Associação dos dados existentes ao proprietário inicial

Os registos existentes pertencem ao proprietário inicial do Watchly: `fspjorge@gmail.com`.

Associar esses registos apenas quando uma identidade Access JWT válida tiver email igual a `LEGACY_OWNER_EMAIL`, comparado sem distinção entre maiúsculas/minúsculas e removendo espaços periféricos.

Procedimento esperado no primeiro login legítimo do proprietário:

1. Criar ou localizar o registo `users` correspondente ao `auth_subject` validado.
2. Obter o UUID interno desse utilizador.
3. Executar `UPDATE monitors SET user_id = ? WHERE user_id IS NULL` com esse UUID.
4. Não alterar os snapshots: estes continuam ligados aos respectivos `monitor_id`.
5. Garantir que o processo é idempotente e seguro perante logins repetidos.

Nunca atribuir os registos antigos ao primeiro utilizador que entre. Um utilizador diferente de `LEGACY_OWNER_EMAIL` deve ver apenas os registos com o seu próprio `user_id`; registos ainda sem proprietário ficam invisíveis.

Não fundir silenciosamente contas existentes apenas por coincidência de email. Se for necessário resolver uma colisão entre `auth_subject` e email, devolver um erro controlado e documentar o procedimento de resolução, sem transferir monitorizações automaticamente.

### 4.4. Alteração do URL e histórico

Os snapshots antigos têm de continuar acessíveis ao proprietário e preservar o URL que lhes deu origem.

Ao editar o URL de uma monitorização:

- actualizar o URL actual em `monitors`;
- não apagar snapshots antigos;
- actualizar o estado para `pending` e limpar `last_error`;
- a primeira verificação do novo URL cria uma nova referência, sem a comparar com o conteúdo do URL anterior;
- cada novo snapshot guarda o `source_url` efectivamente verificado;
- a operação de diferenças compara apenas snapshots do mesmo `monitor_id` e do mesmo `source_url` actual.

Se a implementação actual não permitir consultar o histórico de todos os URLs, não inventar comparações entre URLs diferentes. Preservar os snapshots antigos na base de dados e deixar a sua consulta completa para uma funcionalidade posterior, salvo se for simples incluí-la sem alargar o âmbito.

## 5. Gestão e isolamento de utilizadores no backend

Criar um módulo dedicado, por exemplo `worker/auth.ts`, responsável por:

- validar o JWT;
- obter/criar o utilizador;
- actualizar `last_login_at`;
- executar a associação controlada dos dados antigos;
- devolver o utilizador autenticado.

Criar `GET /api/me`, que devolve apenas o perfil do utilizador autenticado (id, email, name, created_at).

Todas as rotas `/api/*`, incluindo as que forem adicionadas no futuro, devem passar pelo middleware de autenticação antes de executar operações de dados.

Passar o utilizador autenticado como argumento explícito às funções de negócio. Não obter o `user_id` de dados fornecidos pelo frontend.

### 5.1. Consultas obrigatoriamente limitadas ao proprietário

Rever todas as operações:

- `listMonitors`: `WHERE user_id = ?`;
- `createMonitor`: gravar o `user_id` autenticado;
- `getMonitor`: procurar por `id` **e** `user_id`;
- `checkMonitor`: confirmar a propriedade antes de recolher a página;
- `getMonitorDiff`: confirmar a propriedade e filtrar snapshots pelo monitor e URL actual;
- `updateMonitor`: actualizar por `id` e `user_id`;
- `deleteMonitor`: apagar por `id` e `user_id`.

Nunca fazer primeiro uma consulta global por ID e só depois filtrar na interface. A condição de propriedade deve estar na própria query SQL.

Se uma monitorização existir mas pertencer a outro utilizador, devolver `404` (não revelar a existência do recurso). Não devolver snapshots nem informações de outro proprietário.

O frontend não deve enviar `user_id` em nenhum pedido. Se o enviar, o backend deve ignorá-lo ou rejeitar o pedido; nunca o usar.

### 5.2. API de gestão

Manter as rotas existentes e acrescentar:

- `GET /api/me` — perfil autenticado;
- `PATCH /api/monitors/:id` — editar nome e/ou URL;
- `DELETE /api/monitors/:id` — apagar a monitorização própria.

Validar os corpos JSON, limitar o nome, validar os URLs através da função anti-SSRF existente e manter mensagens de erro em Português de Portugal.

Na eliminação, apagar também os snapshots associados através de `ON DELETE CASCADE` ou de uma operação D1 atómica equivalente. Confirmar que a eliminação é limitada ao proprietário.

## 6. Frontend

Manter o design actual do Watchly e o idioma Português de Portugal. Evitar redesenhar a aplicação sem necessidade.

Adicionar ao cabeçalho:

- nome do utilizador autenticado;
- email do utilizador;
- botão de terminar sessão existente, apontando para `/cdn-cgi/access/logout`.

Adicionar a cada monitorização:

- botão **Editar**;
- botão **Apagar**;
- manter **Verificar agora** e **Ver diferenças**.

A edição deve permitir alterar o nome e o URL. Pedir confirmação antes de apagar. Apresentar feedback de sucesso e erros de forma clara.

Ao iniciar, carregar `/api/me` e `GET /api/monitors`. Se a API devolver `401` ou `403`, mostrar uma mensagem de sessão/autorização e não apresentar dados antigos em cache.

Não guardar identidade ou dados sensíveis de autenticação em `localStorage`. A autenticação é gerida pelo Cloudflare Access.

Cada utilizador novo deve ver um dashboard vazio e poder adicionar as suas primeiras monitorizações.

## 7. Configuração de acesso para registo aberto

Esta parte é feita no painel Cloudflare, não pelo código. O OpenCode deve documentar os passos, mas **não deve alterar o painel nem as políticas remotamente**.

Configuração pretendida para permitir qualquer conta Google:

- aplicação Access do Watchly com Google como único Identity Provider seleccionado;
- `Accept all available identity providers` desactivado;
- política `Allow` com regra `Include: Everyone`;
- sem regras `Exclude` ou `Require` que bloqueiem inadvertidamente utilizadores;
- não usar `Bypass` nem deixar a aplicação sem política de acesso.

A política `Everyone` só permite identidades que tenham passado pela autenticação do fornecedor seleccionado. O frontend e o Worker continuam a exigir JWT válido.

Documentar as limitações externas actuais:

- Cloudflare Zero Trust Free tem limites de utilizadores incluídos; confirmar no painel o limite aplicável à conta antes de disponibilizar a aplicação publicamente;
- Google OAuth em modo Testing pode limitar o acesso a utilizadores de teste. Confirmar a regra aplicável à configuração de Sign in with Google e aos scopes `openid`, `email`, `profile` antes de anunciar registo aberto;
- não pedir scopes Google adicionais (Gmail, Drive, Calendar, etc.).

Não alterar automaticamente o modo de publicação OAuth Google, não solicitar verificação Google e não activar planos pagos.

## 8. Testes obrigatórios

Preservar os 40 testes existentes e acrescentar testes para:

### Autenticação

- pedido sem `Cf-Access-Jwt-Assertion` devolve `401`;
- token com assinatura inválida é rejeitado;
- issuer incorrecto é rejeitado;
- audience incorrecta é rejeitada;
- token expirado ou ainda não válido é rejeitado;
- `sub` ou email ausente/inválido é rejeitado;
- JWT válido produz a identidade esperada;
- JWK é obtida do endpoint certo e pode ser reutilizada em cache;
- modo local só funciona com activação explícita e hostname loopback.

### Registo de utilizadores

- primeiro login cria perfil;
- login seguinte reutiliza o mesmo perfil;
- actualização de nome/email mantém a identidade por `auth_subject`;
- email igual com subject diferente não causa fusão automática indevida;
- associação dos registos antigos ocorre apenas para `LEGACY_OWNER_EMAIL`;
- associação dos registos antigos é idempotente;
- um utilizador novo não recebe monitorizações sem proprietário.

### Isolamento entre utilizadores

Criar dois utilizadores de teste, A e B, e monitorizações distintas.

Verificar que:

- A só lista monitorizações de A;
- B só lista monitorizações de B;
- A não consegue verificar uma monitorização de B;
- A não consegue consultar diferenças de B;
- A não consegue editar uma monitorização de B;
- A não consegue apagar uma monitorização de B;
- tentativas de enviar `user_id` de outra conta não permitem contornar a autorização;
- IDs válidos de recursos alheios devolvem `404`.

### Gestão e histórico

- editar apenas o nome preserva o histórico e permite comparar o mesmo URL;
- alterar o URL preserva os snapshots antigos;
- a primeira verificação do novo URL cria uma referência nova;
- nunca comparar snapshots de URLs diferentes;
- apagar uma monitorização própria apaga os respectivos snapshots;
- apagar uma monitorização alheia devolve `404` e não altera dados.

### Validação final

Executar:

```powershell
npm test
npm run lint
npm run build
```

Todos devem terminar sem erros. Indicar o número total de testes aprovados.

Testar também a migração `0002` numa D1 local com cópia de dados representativa, confirmando que os IDs, conteúdos, hashes, timestamps e relações dos snapshots antigos ficam preservados.

## 9. Plano de implementação recomendado

Implementar pela ordem seguinte, sem misturar alterações de produção:

1. Inspeccionar o projecto e criar um plano curto de alterações.
2. Criar a migração `0002_multiuser_ownership.sql`.
3. Implementar validação JWT e middleware de autenticação.
4. Implementar criação/actualização de utilizadores e associação controlada dos dados antigos.
5. Tornar todas as queries e operações D1 dependentes do utilizador autenticado.
6. Implementar `GET /api/me`, `PATCH` e `DELETE`.
7. Actualizar o frontend com perfil, edição e eliminação.
8. Implementar testes de autenticação, isolamento, migração e gestão.
9. Executar testes, lint e build; corrigir os problemas.
10. Apresentar relatório final e instruções manuais para configurar produção.

Trabalhar numa branch separada, por exemplo `feature/multiuser`, mantendo `main` como versão estável. Se a branch já existir, inspeccioná-la antes de criar outra.

## 10. Restrições importantes

- Não publicar na Cloudflare.
- Não executar `wrangler deploy`.
- Não aplicar migrações com `--remote`.
- Não alterar a configuração/políticas do Cloudflare Access.
- Não alterar nem apagar `0001_initial_schema.sql`.
- Não apagar nem reescrever as monitorizações ou snapshots existentes.
- Não introduzir credenciais, Client Secrets ou tokens no Git.
- Não implementar autenticação Google própria: usar exclusivamente Cloudflare Access.
- Não remover, simplificar ou enfraquecer a protecção SSRF, incluindo a validação de todos os redirects.
- Não acrescentar funcionalidades de pagamentos, planos, notificações, scraping agendado ou MCP nesta tarefa.

## 11. Relatório final esperado

No fim, apresentar:

1. Ficheiros criados e alterados.
2. Conteúdo e finalidade da migração `0002`.
3. Como é validado o JWT Access.
4. Como é feito o registo automático.
5. Como são isoladas as operações por `user_id`.
6. Como os dados antigos do proprietário inicial são preservados e associados.
7. Como editar e apagar monitorizações.
8. Resultados de `npm test`, `npm run lint` e `npm run build`.
9. Variáveis que têm de ser configuradas manualmente na Cloudflare (`TEAM_DOMAIN`, `ACCESS_AUD`, `LEGACY_OWNER_EMAIL`).
10. Passos manuais necessários para disponibilizar o registo a qualquer conta Google, incluindo as limitações de Zero Trust e Google OAuth.

A implementação só está concluída quando os testes demonstrarem que dois utilizadores não conseguem, por nenhuma rota da API, consultar ou alterar os dados um do outro.
