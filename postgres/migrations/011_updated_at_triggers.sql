-- =============================================================
-- Migration 011: updated_at triggers
-- Shared trigger function + per-table triggers that automatically
-- set updated_at = now() on every UPDATE, so application code
-- never has to remember to set it manually.
-- =============================================================

CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- platform_users
CREATE TRIGGER trg_platform_users_updated_at
  BEFORE UPDATE ON platform_users
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ai_agents
CREATE TRIGGER trg_ai_agents_updated_at
  BEFORE UPDATE ON ai_agents
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- prompts
CREATE TRIGGER trg_prompts_updated_at
  BEFORE UPDATE ON prompts
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- knowledge_bases
CREATE TRIGGER trg_knowledge_bases_updated_at
  BEFORE UPDATE ON knowledge_bases
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- kb_documents
CREATE TRIGGER trg_kb_documents_updated_at
  BEFORE UPDATE ON kb_documents
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- campaigns
CREATE TRIGGER trg_campaigns_updated_at
  BEFORE UPDATE ON campaigns
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- leads
CREATE TRIGGER trg_leads_updated_at
  BEFORE UPDATE ON leads
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
