# Server Structure

```mermaid
flowchart TD
  CLI["CLI Entry<br/>src/cli.ts"] --> PServer["Proxy Server<br/>src/proxy/server.ts"]
  CLI --> AServer["Analysis Server<br/>src/analysis/server.ts"]

  subgraph ProxyRuntime["Proxy Runtime (:4040)"]
    PServer --> PConfig["Config<br/>src/proxy/config.ts"]
    PServer --> PForward["Request Forwarder<br/>src/proxy/forward.ts"]
    PServer --> PCapture["Capture Writer<br/>src/proxy/capture.ts"]
    PForward --> PRouting["Routing/Provider Detection<br/>src/proxy/routing.ts"]
    PForward --> PHeaders["Header Redaction<br/>src/proxy/headers.ts"]
  end

  subgraph AnalysisRuntime["Analysis + Web UI Runtime (:4041)"]
    AServer --> Watcher["Capture Watcher<br/>src/analysis/watcher.ts"]
    Watcher --> Ingest["Capture Ingest<br/>src/analysis/ingest.ts"]
    Ingest --> CoreFacade["Core Facade<br/>src/core.ts"]
    Ingest --> Store["State Store<br/>src/server/store.ts"]

    AServer --> WebUI["Web UI Handler<br/>src/server/webui.ts"]
    WebUI --> API["API Handler<br/>src/server/api.ts"]
    WebUI --> Static["Static Handler<br/>src/server/static.ts"]
    API --> Store
  end

  subgraph DomainModules["Domain / Shared Modules"]
    CoreFacade --> CoreMod["Core Modules<br/>src/core/*"]
    Store --> Projection["Entry Projection<br/>src/server/projection.ts"]
    Store --> LharFacade["LHAR Facade<br/>src/lhar.ts"]
    LharFacade --> LharMod["LHAR Modules<br/>src/lhar/*"]
    LharMod --> HttpHeaders["Shared Header Utils<br/>src/http/headers.ts"]
    Store --> ServerUtils["Server Utils<br/>src/server-utils.ts"]
  end

  PCapture -->|JSON capture files| Watcher
  Store -->|state.jsonl + details/*.json + *.lhar| Disk[(Local Disk)]
  PForward -->|proxied HTTP(S)| Upstreams[(OpenAI / Anthropic / Gemini / ChatGPT)]
```
