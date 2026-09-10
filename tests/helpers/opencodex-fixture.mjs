export function buildOpenCodexGatewayConfig({
  port,
  bridgeBaseUrl,
  modelAlias,
  claudeCodeModelId,
  providerName = 'governed-gateway',
}) {
  const routedModel = `${providerName}/${modelAlias}`;
  return {
    port,
    hostname: '127.0.0.1',
    providers: {
      [providerName]: {
        adapter: 'openai-responses',
        baseUrl: bridgeBaseUrl,
        apiKey: 'placeholder-replaced-by-bridge',
        defaultModel: modelAlias,
        models: [modelAlias],
        liveModels: false,
        allowPrivateNetwork: true,
      },
    },
    defaultProvider: providerName,
    clientIntegrations: {
      codex: false,
      grok: false,
      'claude-desktop': false,
    },
    claudeCode: {
      enabled: true,
      nativePassthrough: false,
      model: routedModel,
      smallFastModel: routedModel,
      modelMap: {
        [claudeCodeModelId]: routedModel,
      },
      systemEnv: false,
      injectAgents: false,
    },
    syncResumeHistory: false,
  };
}
