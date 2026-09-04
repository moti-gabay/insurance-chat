# Insurance Chat — השוואת פוליסות ביטוח רכב

A RAG chatbot that answers questions about Israeli car insurance policies and
cites the source documents it used. Hebrew RTL interface.

## Architecture

```
Browser (public/index.html)
      │  POST /api/chat
      ▼
Express server (server.js)  ── Azure App Service: insurance-chat-moti
      │  Bearer token from DefaultAzureCredential
      ▼
Azure AI Foundry Agent (Responses API)
      │  retrieval
      ▼
Azure AI Search  ──indexes──▶  Azure Blob Storage (policy PDFs)
```

The server holds no model logic and no keys. It authenticates with
`DefaultAzureCredential` — a Service Principal locally, the App Service managed
identity in production — forwards the question to the Foundry Agent, then
strips the inline citation markers and returns the answer plus the list of
source file names.

Conversation continuity is handled by the Agent: the client sends back the
previous `responseId` as `previous_response_id`.

## Endpoints

| Method | Path          | Description                                          |
|--------|---------------|------------------------------------------------------|
| POST   | `/api/chat`   | Body `{ question, previousResponseId? }` → `{ answer, sources, responseId }` |
| GET    | `/api/me`     | `{ name }` of the signed-in user — `null` when running locally |
| GET    | `/api/health` | Liveness check                                       |

## Local setup

```bash
npm install
cp .env.example .env    # fill in the values — never commit this file
node server.js          # http://localhost:3000
```

The Service Principal in `.env` needs the **Azure AI User** role on the Foundry
project.

## Environment variables

| Variable              | Required | Description                                            |
|-----------------------|----------|--------------------------------------------------------|
| `AGENT_URL`           | yes      | Foundry Agent Responses API endpoint                   |
| `AZURE_CLIENT_ID`     | local    | Service Principal app ID                               |
| `AZURE_CLIENT_SECRET` | local    | Service Principal secret — local only, never committed |
| `AZURE_TENANT_ID`     | local    | Entra tenant ID                                        |
| `AZURE_SCOPE`         | no       | Token scope (default `https://ai.azure.com/.default`)  |
| `DEBUG_AGENT`         | no       | `true` logs the raw agent payload                      |
| `PORT`                | no       | Listen port (default `3000`; App Service sets this)    |

In App Service, set `AGENT_URL` under **Configuration → Application settings**
and enable the system-assigned managed identity instead of the three
`AZURE_*` credential variables.

## Authentication

The deployed site is behind **App Service built-in authentication (Easy Auth)**
with Microsoft Entra ID, single tenant. Every request is authenticated — there
is no anonymous path, `/api/health` included.

| Setting                      | Value                                     |
|------------------------------|-------------------------------------------|
| Identity provider            | Microsoft, current tenant (workforce)     |
| Supported account types      | Single tenant                             |
| Restrict access              | Require authentication                    |
| Unauthenticated requests     | HTTP 302 redirect to the login page       |
| Token store                  | Enabled                                   |

Easy Auth runs as a separate container ahead of the Node process, so the app
never sees an unauthenticated request and the check cannot be bypassed in
application code. To exempt a path — an uptime probe, say, or a
`healthCheckPath` — add it to `globalValidation.excludedPaths` in the
`authsettingsV2` config; an Express route cannot do it.

The signed-in user reaches the app as request headers, not as a token to parse:
`X-MS-CLIENT-PRINCIPAL-NAME` holds the UPN, and `X-MS-CLIENT-PRINCIPAL` holds
base64-encoded claims JSON. `/api/me` decodes the display name out of it for
the page header. Both headers are absent locally, so the header stays hidden.

Verifying with `curl` is misleading: Easy Auth returns **401 to non-browser
clients** and only redirects requests that look like a browser. To see the 302,
send a browser User-Agent:

```bash
curl -sS -o /dev/null -D - \
  -H 'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120' \
  https://insurance-chat-moti.azurewebsites.net/
```

The `Location` host is `login.windows.net` — the v1 hostname Entra still emits,
equivalent to `login.microsoftonline.com`.

> **Secret expiry.** The wizard created an Entra app registration and stored its
> client secret in the `MICROSOFT_PROVIDER_AUTHENTICATION_SECRET` app setting.
> That secret expires. When it does, sign-in breaks with `AADSTS7000215` —
> rotate it under **Entra ID → App registrations → insurance-chat-moti →
> Certificates & secrets**, then update the app setting.

Changing the auth config on Linux App Service does not take effect until the
site restarts — the auth container is injected at container start.

## Deployment

Every push to `main` triggers `.github/workflows/deploy.yml`, which builds on
Node 22 and deploys to App Service `insurance-chat-moti`.

Basic-auth publishing (SCM and FTP) is disabled on the app, so publish-profile
deployment does not work. The workflow authenticates with `azure/login` using
the `AZURE_CREDENTIALS` repository secret — a JSON object holding `clientId`,
`clientSecret`, `tenantId` and `subscriptionId` for a service principal with
Contributor on `rg-insurance-bot`.
