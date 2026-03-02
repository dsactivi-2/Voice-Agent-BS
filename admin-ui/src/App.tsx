import { Admin, Resource, CustomRoutes } from 'react-admin';
import { Route } from 'react-router-dom';

import { authProvider } from './providers/authProvider';
import { dataProvider } from './providers/dataProvider';
import { darkTheme, lightTheme } from './theme';

// Agents
import { AgentList } from './pages/agents/AgentList';
import { AgentCreate } from './pages/agents/AgentCreate';
import { AgentEdit } from './pages/agents/AgentEdit';

// Campaigns
import { CampaignList } from './pages/campaigns/CampaignList';
import { CampaignCreate } from './pages/campaigns/CampaignCreate';
import { CampaignEdit } from './pages/campaigns/CampaignEdit';

// Dispositions (custom pages — nested under campaign)
import { DispositionList } from './pages/dispositions/DispositionList';
import { DispositionCreate } from './pages/dispositions/DispositionCreate';

// Prompts
import { PromptList } from './pages/prompts/PromptList';
import { PromptCreate } from './pages/prompts/PromptCreate';
import { PromptEdit } from './pages/prompts/PromptEdit';

// Knowledge Bases
import { KbList } from './pages/knowledge-bases/KbList';
import { KbCreate } from './pages/knowledge-bases/KbCreate';
import { KbEdit } from './pages/knowledge-bases/KbEdit';
import { KbDocuments } from './pages/knowledge-bases/KbDocuments';

// DNC
import { DncList } from './pages/dnc/DncList';

// Events (pure custom component — rendered via CustomRoute)
import { EventList } from './pages/events/EventList';

// Leads (custom pages — nested under campaign)
import { LeadListsByCampaign } from './pages/leads/LeadListsByCampaign';
import { LeadTable } from './pages/leads/LeadTable';
import { CsvImportPage } from './pages/leads/CsvImportPage';

export function App() {
  return (
    <Admin
      dataProvider={dataProvider}
      authProvider={authProvider}
      theme={lightTheme}
      darkTheme={darkTheme}
      defaultTheme="dark"
    >
      <Resource
        name="agents"
        list={AgentList}
        create={AgentCreate}
        edit={AgentEdit}
        options={{ label: 'Agenten' }}
      />
      <Resource
        name="campaigns"
        list={CampaignList}
        create={CampaignCreate}
        edit={CampaignEdit}
        options={{ label: 'Kampagnen' }}
      />
      <Resource
        name="prompts"
        list={PromptList}
        create={PromptCreate}
        edit={PromptEdit}
        options={{ label: 'Prompts' }}
      />
      <Resource
        name="knowledge-bases"
        list={KbList}
        create={KbCreate}
        edit={KbEdit}
        options={{ label: 'Knowledge Bases' }}
      />
      <Resource
        name="dnc"
        list={DncList}
        options={{ label: 'DNC Liste' }}
      />

      <CustomRoutes>
        {/* Events — pure SSE component, no react-admin List */}
        <Route path="/events" element={<EventList />} />

        {/* Campaigns → Dispositions */}
        <Route path="/campaigns/:id/dispositions" element={<DispositionList />} />
        <Route path="/campaigns/:id/dispositions/create" element={<DispositionCreate />} />

        {/* Campaigns → Leads */}
        <Route path="/campaigns/:id/leads" element={<LeadListsByCampaign />} />
        <Route path="/campaigns/:id/leads/:listId" element={<LeadTable />} />
        <Route path="/campaigns/:id/import-leads" element={<CsvImportPage />} />

        {/* Knowledge Bases → Documents */}
        <Route path="/knowledge-bases/:id/documents" element={<KbDocuments />} />
      </CustomRoutes>
    </Admin>
  );
}
