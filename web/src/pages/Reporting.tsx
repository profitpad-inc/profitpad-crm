import { useState, useEffect } from 'react';
import { api } from '../lib/api';

export function Reporting() {
  // Tabs and filter state
  const [activeTab, setActiveTab] = useState<'dash1' | 'dash2'>('dash1');
  const [activeFilter, setActiveFilter] = useState<string>('All');

  // KPI state
  const [contactsCount, setContactsCount] = useState<number | null>(null);
  const [openDealsCount, setOpenDealsCount] = useState<number | null>(null);
  const [newLeadsCount, setNewLeadsCount] = useState<number | null>(null);
  const [revenue, setRevenue] = useState<number | null>(null);

  const [ticketsOpen, setTicketsOpen] = useState<number | null>(null);
  const [avgResolution, setAvgResolution] = useState<string | null>(null);
  const [slaBreaches, setSlaBreaches] = useState<number | null>(null);
  const [customerNps, setCustomerNps] = useState<string | null>(null);

  const tabs = [
    { id: 'dash1', label: 'Dashboard 1' },
    { id: 'dash2', label: 'Dashboard 2' },
  ];

  const filters = ['All', 'Last 7 days', 'Last 30 days', 'Year to‑date'];

  // Helper to fetch total count for an object
  async function fetchTotal(object: string, extraQuery: any = {}): Promise<number> {
    const resp = await api<{ total: number }>('POST', `/v1/objects/${object}/search`, {
      limit: 0,
      ...extraQuery,
    });
    return resp.total;
  }

  // Load KPI data (simplified – real dashboards would aggregate more precisely)
  useEffect(() => {
    // contacts
    fetchTotal('contacts')
      .then(setContactsCount)
      .catch(() => setContactsCount(null));
    // open deals – we consider any deal not in closed_won/closed_lost
    fetchTotal('deals', { filter: { stage: { $nin: ['closed_won', 'closed_lost'] } } })
      .then(setOpenDealsCount)
      .catch(() => setOpenDealsCount(null));
    // new leads – contacts with lifecycle_stage = 'lead'
    fetchTotal('contacts', { filter: { lifecycle_stage: 'lead' } })
      .then(setNewLeadsCount)
      .catch(() => setNewLeadsCount(null));
    // revenue – placeholder using count * avg amount
    fetchTotal('deals', { filter: { stage: 'closed_won' } })
      .then(cnt => setRevenue(cnt * 15000))
      .catch(() => setRevenue(null));
    // tickets open – count of tickets with status not closed
    fetchTotal('tickets', { filter: { status: { $ne: 'closed' } } })
      .then(setTicketsOpen)
      .catch(() => setTicketsOpen(null));
    // static placeholders for other KPIs
    setAvgResolution('3.2 d');
    setSlaBreaches(1);
    setCustomerNps('+42');
  }, [activeFilter]);

  const formatNumber = (n: number | null) => (n === null ? '…' : n.toLocaleString());
  const formatCurrency = (n: number | null) => (n === null ? '…' : `$${n.toLocaleString()}`);

  return (
    <div className="page reporting-container">
      {/* Header */}
      <div className="reporting-header-row">
        <div>
          <h1 className="reporting-heading">Reporting</h1>
          <p className="reporting-subheading">
            AI‑generated dashboards – click a tab to explore.
          </p>
        </div>
        {/* Quick filter pills */}
        <div className="reporting-pills-container">
          {filters.map((f) => (
            <button
              key={f}
              className={`reporting-pill-btn${activeFilter === f ? ' active' : ''}`}
              onClick={() => setActiveFilter(f)}
            >
              {f}
            </button>
          ))}
        </div>
      </div>

      {/* Nav tabs */}
      <div className="reporting-nav-tabs">
        {tabs.map((t) => (
          <button
            key={t.id}
            className={`reporting-nav-tab${activeTab === t.id ? ' active' : ''}`}
            onClick={() => setActiveTab(t.id as 'dash1' | 'dash2')}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Dashboard 1 */}
      {activeTab === 'dash1' && (
        <div>
          <div className="reporting-kpis-grid">
            <div className="reporting-kpi-card">
              <div className="reporting-kpi-title">Total Contacts</div>
              <div className="reporting-kpi-num">{formatNumber(contactsCount)}</div>
              <div className="reporting-kpi-caption">as of today</div>
            </div>
            <div className="reporting-kpi-card">
              <div className="reporting-kpi-title">Open Deals</div>
              <div className="reporting-kpi-num">{formatNumber(openDealsCount)}</div>
              <div className="reporting-kpi-caption">value ≈ {formatCurrency(revenue)}</div>
            </div>
            <div className="reporting-kpi-card">
              <div className="reporting-kpi-title">New Leads</div>
              <div className="reporting-kpi-num">{formatNumber(newLeadsCount)}</div>
              <div className="reporting-kpi-caption">this week</div>
            </div>
            <div className="reporting-kpi-card">
              <div className="reporting-kpi-title">Revenue</div>
              <div className="reporting-kpi-num">{formatCurrency(revenue)}</div>
              <div className="reporting-kpi-caption">YTD</div>
            </div>
          </div>
          <div className="reporting-panel-card" style={{ marginTop: '24px' }}>
            <div className="reporting-panel-title">Top Companies</div>
            <div className="reporting-panel-desc">Based on deal value in the selected period.</div>
            <div className="reporting-table-wrap">
              <table className="reporting-table">
                <thead>
                  <tr>
                    <th>Company</th>
                    <th>Deals</th>
                    <th>Value</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>Acme Corp</td>
                    <td>5</td>
                    <td>$45 k</td>
                    <td><span className="status-badge success">Closed</span></td>
                  </tr>
                  <tr>
                    <td>Globex</td>
                    <td>3</td>
                    <td>$30 k</td>
                    <td><span className="status-badge warning">Pending</span></td>
                  </tr>
                  <tr>
                    <td>Initech</td>
                    <td>2</td>
                    <td>$12 k</td>
                    <td><span className="status-badge idle">Prospect</span></td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* Dashboard 2 */}
      {activeTab === 'dash2' && (
        <div>
          <div className="reporting-kpis-grid">
            <div className="reporting-kpi-card">
              <div className="reporting-kpi-title">Tickets Open</div>
              <div className="reporting-kpi-num">{formatNumber(ticketsOpen)}</div>
              <div className="reporting-kpi-caption">support backlog</div>
            </div>
            <div className="reporting-kpi-card">
              <div className="reporting-kpi-title">Avg. Resolution</div>
              <div className="reporting-kpi-num">{avgResolution ?? '…'}</div>
              <div className="reporting-kpi-caption">last 30 d</div>
            </div>
            <div className="reporting-kpi-card">
              <div className="reporting-kpi-title">SLA Breaches</div>
              <div className="reporting-kpi-num">{formatNumber(slaBreaches)}</div>
              <div className="reporting-kpi-caption">this month</div>
            </div>
            <div className="reporting-kpi-card">
              <div className="reporting-kpi-title">Customer NPS</div>
              <div className="reporting-kpi-num">{customerNps ?? '…'}</div>
              <div className="reporting-kpi-caption">quarterly</div>
            </div>
          </div>
          <div className="reporting-panel-card" style={{ marginTop: '24px' }}>
            <div className="reporting-panel-title">Recent Tickets</div>
            <div className="reporting-panel-desc">Showing the latest 5 tickets.</div>
            <div className="reporting-table-wrap">
              <table className="reporting-table">
                <thead>
                  <tr>
                    <th>Ticket</th>
                    <th>Subject</th>
                    <th>Owner</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>#1023</td>
                    <td>Login issue</td>
                    <td>Jane Doe</td>
                    <td><span className="status-badge warning">Open</span></td>
                  </tr>
                  <tr>
                    <td>#1022</td>
                    <td>Invoice discrepancy</td>
                    <td>John Smith</td>
                    <td><span className="status-badge success">Resolved</span></td>
                  </tr>
                  <tr>
                    <td>#1021</td>
                    <td>Feature request</td>
                    <td>Emily Ray</td>
                    <td><span className="status-badge idle">Pending</span></td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
