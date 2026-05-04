require("dotenv").config();

const express = require("express");
const axios = require("axios");
const cors = require("cors");
const dns = require("dns").promises;
const { URL } = require("url");

const app = express();

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3001;

function loadSystemsFromEnv() {
  // Função para resolver variáveis com $
  function resolveEnvVar(value) {
    if (typeof value === 'string' && value.startsWith('$')) {
      const varName = value.slice(1);
      return process.env[varName] || value;
    }
    return value;
  }

  if (process.env.SYSTEMS) {
    try {
      const parsed = JSON.parse(process.env.SYSTEMS);
      if (Array.isArray(parsed)) {
        return parsed.map((system) => ({
          name: system.name,
          url: system.url,
          method: system.method || "GET"
        }));
      }
    } catch (error) {
      console.warn("Falha ao parsear SYSTEMS:", error.message);
    }
  }

  const envSystems = [];

  if (process.env.SYSTEM_NAME && process.env.SYSTEM_URL) {
    envSystems.push({
      name: process.env.SYSTEM_NAME,
      url: process.env.SYSTEM_URL,
      method: process.env.SYSTEM_METHOD || "GET"
    });
  }

  const numbered = {};
  Object.keys(process.env).forEach((key) => {
    const match = key.match(/^SYSTEM_(NAME|URL|METHOD|AUTH_URL|AUTH_MATRICULA|AUTH_PASSWORD|AUTH_TOKEN_PATH)_(\d+)$/);
    if (!match) return;
    const [, field, index] = match;
    numbered[index] = numbered[index] || {};
    numbered[index][field.toLowerCase()] = resolveEnvVar(process.env[key]);
  });

  Object.keys(numbered)
    .sort((a, b) => Number(a) - Number(b))
    .forEach((index) => {
      const system = numbered[index];
      if (system.name && system.url) {
        envSystems.push({
          name: system.name,
          url: system.url,
          method: system.method || "GET",
          auth_url: system.auth_url,
          auth_matricula: system.auth_matricula,
          auth_password: system.auth_password,
          auth_token_path: system.auth_token_path || "token"
        });
      }
    });

  return envSystems;
}

// Função para extrair valor de um objeto usando path (ex: "data.token")
function getValueByPath(obj, path) {
  return path.split('.').reduce((current, prop) => current?.[prop], obj);
}

function getQueryParam(urlString, name) {
  try {
    const url = new URL(urlString);
    return url.searchParams.get(name);
  } catch {
    return null;
  }
}

// Função para fazer login e retornar token
async function authenticateSystem(authUrl, matricula, password, tokenPath) {
  try {
    const payload = {
      matricula,
      password
    };
    const response = await axios.post(authUrl, payload, { timeout: 10000, validateStatus: () => true });
    if (response.status < 200 || response.status >= 300) {
      console.error(`Autenticação falhou em ${authUrl}: HTTP ${response.status}`);
      return null;
    }
    const token = getValueByPath(response.data, tokenPath);
    return token;
  } catch (error) {
    console.error(`Erro ao autenticar em ${authUrl}:`, error.message);
    return null;
  }
}

// 🔧 Sistemas vindo do .env
const systems = loadSystemsFromEnv();

// 🔍 função de check DNS
async function checkDNS(hostname) {
  try {
    await dns.lookup(hostname);
    return true;
  } catch {
    return false;
  }
}

app.get("/check", async (req, res) => {
  const results = await Promise.all(
    systems.map(async (system) => {
      const start = Date.now();

      if (!system.url) {
        return {
          name: system.name,
          url: system.url,
          status: 0,
          error: "INVALID_URL",
          time: 0,
          success: false,
          message: "URL inválida"
        };
      }

      let hostname;

      try {
        hostname = new URL(system.url).hostname;
      } catch {
        return {
          name: system.name,
          url: system.url,
          status: 0,
          error: "BAD_URL_FORMAT",
          time: Date.now() - start,
          success: false,
          message: "Formato de URL inválido"
        };
      }

      // 🧠 1. valida DNS
      const dnsOk = await checkDNS(hostname);

      if (!dnsOk) {
        return {
          name: system.name,
          url: system.url,
          status: 0,
          error: "DNS_NOT_FOUND",
          time: Date.now() - start,
          success: false,
          message: "DNS não encontrado"
        };
      }

      try {
        // 🌐 2. request HTTP
        let headers = {};
        let targetUrl = system.url;
        let authToken = null;

        // 🔐 Se precisa autenticar, faz login primeiro
        if (system.auth_url && system.auth_matricula && system.auth_password) {
          authToken = await authenticateSystem(system.auth_url, system.auth_matricula, system.auth_password, system.auth_token_path);
          if (!authToken) {
            return {
              name: system.name,
              url: system.url,
              status: 0,
              error: "AUTH_FAILED",
              time: Date.now() - start,
              success: false,
              message: "Falha na autenticação"
            };
          }
          headers.Authorization = `Bearer ${authToken}`;
        }

        const redirectTarget = getQueryParam(system.url, 'url');
        if (redirectTarget) {
          targetUrl = redirectTarget;
        }

        const response = await axios({
          method: system.method,
          url: targetUrl,
          headers,
          timeout: 10000,
          validateStatus: () => true,
          maxRedirects: 5
        });

        return {
          name: system.name,
          url: system.url,
          status: response.status,
          time: Date.now() - start,
          success: response.status >= 200 && response.status < 400,
          message: response.status >= 200 && response.status < 400 ? "OK" : response.statusText || "Erro"
        };

      } catch (error) {
        return {
          name: system.name,
          url: system.url,
          status: 0,
          error: error.code || "REQUEST_FAILED",
          time: Date.now() - start,
          success: false,
          message: "Erro de conexão"
        };
      }
    })
  );

  res.json(results);
});

app.listen(PORT, () => {
  console.log(`🚀 Backend rodando em http://localhost:${PORT}`);
});