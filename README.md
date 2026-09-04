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

## Deployment

Every push to `main` triggers `.github/workflows/deploy.yml`, which builds on
Node 22 and deploys to App Service `insurance-chat-moti`.

Basic-auth publishing (SCM and FTP) is disabled on the app, so publish-profile
deployment does not work. The workflow authenticates with `azure/login` using
the `AZURE_CREDENTIALS` repository secret — a JSON object holding `clientId`,
`clientSecret`, `tenantId` and `subscriptionId` for a service principal with
Contributor on `rg-insurance-bot`.
