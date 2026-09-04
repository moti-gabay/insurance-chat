require("dotenv").config();

const express = require("express");
const path = require("path");
const { DefaultAzureCredential } = require("@azure/identity");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const AGENT_URL = process.env.AGENT_URL;

if (!AGENT_URL) {
  console.error("Missing AGENT_URL. Add it to .env — see .env.example.");
  process.exit(1);
}

// DefaultAzureCredential picks up the service principal from .env locally,
// and the App Service managed identity in production. No keys in the code.
const credential = new DefaultAzureCredential();
const SCOPE = process.env.AZURE_SCOPE || "https://ai.azure.com/.default";

let cachedToken = null;

async function getToken() {
  if (cachedToken && cachedToken.expiresOnTimestamp - Date.now() > 60_000) {
    return cachedToken.token;
  }
  cachedToken = await credential.getToken(SCOPE);
  return cachedToken.token;
}

// Pull the answer text and cited sources out of the Responses payload.
function parseAgentResponse(data) {
  let text = "";
  const sources = new Set();

  const walk = (node) => {
    if (!node || typeof node !== "object") return;

    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }

    if (node.type === "output_text" && typeof node.text === "string") {
      text += node.text;
    }

    if (Array.isArray(node.annotations)) {
      for (const a of node.annotations) {
        const name = a.filename || a.file_name || a.title || a.text;
        // Sources arrive as full blob URLs — keep just the file name.
        if (name) sources.add(String(name).split("/").pop());
      }
    }

    Object.values(node).forEach(walk);
  };

  walk(data.output ?? data);

  if (!text && typeof data.output_text === "string") {
    text = data.output_text;
  }

  // Strip internal citation markers like 【6:5†source】 — the sources
  // are already shown separately in the UI.
  text = text.replace(/【[^】]*】/g, "").replace(/[ \t]+\n/g, "\n");

  return { text: text.trim(), sources: [...sources] };
}

app.post("/api/chat", async (req, res) => {
  const question = (req.body.question || "").trim();
  if (!question) {
    return res.status(400).json({ error: "לא נשלחה שאלה." });
  }

  try {
    const token = await getToken();

    const body = { input: question };
    if (req.body.previousResponseId) {
      body.previous_response_id = req.body.previousResponseId;
    }

    const response = await fetch(AGENT_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    const raw = await response.text();

    if (!response.ok) {
      console.error("Agent error", response.status, raw);
      return res.status(response.status).json({
        error: `הסוכן החזיר שגיאה ${response.status}`,
        detail: raw.slice(0, 500),
      });
    }

    const data = JSON.parse(raw);

    if (process.env.DEBUG_AGENT === "true") {
      console.log("--- agent response ---");
      console.log(JSON.stringify(data, null, 2).slice(0, 2000));
    }

    const { text, sources } = parseAgentResponse(data);

    res.json({
      answer: text || "לא התקבלה תשובה מהסוכן.",
      sources,
      responseId: data.id || null,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "שגיאה בפנייה לסוכן.", detail: err.message });
  }
});

// Easy Auth injects the signed-in user's claims ahead of this process.
// The headers are absent when running locally, so name comes back null.
app.get("/api/me", (req, res) => {
  const encoded = req.get("x-ms-client-principal");
  let name = req.get("x-ms-client-principal-name") || null;

  if (encoded) {
    try {
      const { claims } = JSON.parse(
        Buffer.from(encoded, "base64").toString("utf8")
      );
      // Inbound claims are mapped to the long WS-Fed URIs unless
      // clearInboundClaimsMapping is turned on, so accept both spellings.
      const displayName = claims?.find(
        (c) =>
          c.typ === "name" ||
          c.typ === "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name"
      )?.val;
      if (displayName) name = displayName;
    } catch {
      // Malformed header — fall back to the UPN above.
    }
  }

  res.json({ name });
});

app.get("/api/health", (_req, res) => res.json({ ok: true }));

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Listening on http://localhost:${port}`);
});