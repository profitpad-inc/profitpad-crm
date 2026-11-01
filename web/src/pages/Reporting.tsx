import { useState } from 'react';

export function Reporting() {
  // Simple state for the two dashboards
  const [activeTab, setActiveTab] = useState<'dash1' | 'dash2'>('dash1');
  // Simple filter state (could be expanded with real API calls)
  const [activeFilter, setActiveFilter] = useState<string>('All');

  const tabs = [
    { id: 'dash1', label: 'Dashboard 1' },
    { id: 'dash2', label: 'Dashboard 2' },
  ];

  const filters = ['All', 'Last 7 days', 'Last 30 days', 'Year to‑date'];

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

      {/* Nav tabs for the two dashboards */}
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

      {/* Content area – placeholder cards */}
      {activeTab === 'dash1' && (
        <div>
          <div className="reporting-kpis-grid">
            <div className="reporting-kpi-card">
              <div className="reporting-kpi-title">Total Contacts</div>
              <div className="reporting-kpi-num">1 234</div>
              <div className="reporting-kpi-caption">as of today</div>
            </div>
            <div className="reporting-kpi-card">
              <div className="reporting-kpi-title">Open Deals</div>
              <div className="reporting-kpi-num">57</div>
              <div className="reporting-kpi-caption">value ≈ $123 k</div>
            </div>
            <div className="reporting-kpi-card">
              <div className="reporting-kpi-title">New Leads</div>
              <div className="reporting-kpi-num">84</div>
              <div className="reporting-kpi-caption">this week</div>
            </div>
            <div className="reporting-kpi-card">
              <div className="reporting-kpi-title">Revenue</div>
              <div className="reporting-kpi-num">$987 k</div>
              <div className="reporting-kpi-caption">YTD</div>
            </div>
          </div>
          <div className="reporting-panel-card" style={{ marginTop: '24px' }}>
            <div className="reporting-panel-title">Top Companies</div>
            <div className="reporting-panel-desc">Based on deal value in the selected period.</div>
            {/* Placeholder table */}
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

      {activeTab === 'dash2' && (
        <div>
          <div className="reporting-kpis-grid">
            <div className="reporting-kpi-card">
              <div className="reporting-kpi-title">Tickets Open</div>
              <div className="reporting-kpi-num">12</div>
              <div className="reporting-kpi-caption">support backlog</div>
            </div>
            <div className="reporting-kpi-card">
              <div className="reporting-kpi-title">Avg. Resolution</div>
              <div className="reporting-kpi-num">3.2 d</div>
              <div className="reporting-kpi-caption">last 30 d</div>
            </div>
            <div className="reporting-kpi-card">
              <div className="reporting-kpi-title">SLA Breaches</div>
              <div className="reporting-kpi-num">1</div>
              <div className="reporting-kpi-caption">this month</div>
            </div>
            <div className="reporting-kpi-card">
              <div className="reporting-kpi-title">Customer NPS</div>
              <div className="reporting-kpi-num">+42</div>
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

