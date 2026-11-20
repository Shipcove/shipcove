-- Transport MCP stdio retiré : lancé dans la sandbox, il y exposait ses secrets au code de l'agent.
-- Les serveurs existants sont désactivés (ni proposés ni exécutés) ; leurs propriétaires les recréent en Streamable HTTP.
UPDATE "mcp_servers" SET "enabled" = false, "health" = 'unhealthy', "health_detail" = 'Transport stdio retiré : recréez ce serveur en Streamable HTTP' WHERE "transport" = 'stdio';
