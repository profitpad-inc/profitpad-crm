#!/usr/bin/python3
"""HTTP load test against the CRM API, using the same requests the web app sends.

  /usr/bin/python3 http_bench.py single            # each scenario alone, 5 runs, latency
  /usr/bin/python3 http_bench.py concurrent 10 60  # 10 simulated users for 60 s
  /usr/bin/python3 http_bench.py ramp 25,50,100,150 150  # realistic users (about 15 s between actions), 150 s a step,
                                                         # stops once p95 passes 2 s or more than 1% fail

Needs PCRM_API_KEY (or a key file path in PCRM_API_KEY_FILE) and PCRM_API_URL (default https://crm.profitpad.com).
"""
import json, os, random, statistics, sys, threading, time, urllib.request, urllib.error

BASE = os.environ.get('PCRM_API_URL', 'https://crm.profitpad.com')
KEY = os.environ.get('PCRM_API_KEY') or open(os.environ['PCRM_API_KEY_FILE']).read().strip()
TIMEOUT = 60


def call(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method)
    req.add_header('Authorization', 'Bearer ' + KEY)
    if data is not None:
        req.add_header('Content-Type', 'application/json')
    t = time.perf_counter()
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
            payload = r.read()
            status = r.status
    except urllib.error.HTTPError as e:
        payload, status = e.read(), e.code
    except Exception as e:  # timeouts, resets
        return 0, (time.perf_counter() - t) * 1000, str(e).encode()
    return status, (time.perf_counter() - t) * 1000, payload


def search(obj, **body):
    return lambda: call('QUERY', f'/v1/objects/{obj}/search', body)


STRESS_IDS = []


def load_stress_ids():
    # picked once, before any simulated user starts
    if STRESS_IDS:
        return
    s, _, p = call('QUERY', '/v1/objects/contacts/search', {'limit': 200, 'properties': NAME, 'sorts': [{'property': 'created_at', 'direction': 'desc'}],
               'filter_groups': [{'filters': [{'property': 'email', 'operator': 'contains', 'value': '@stress-test.example.com'}]}]})
    if s != 200:
        raise SystemExit(f'could not pick stress-test contacts: {s} {p[:200]!r}')
    STRESS_IDS.extend(r['id'] for r in json.loads(p)['results'])


def edit_contact():
    # edits only stress-test contacts (their emails end in @stress-test.example.com)
    def run():
        load_stress_ids()
        rid = random.choice(STRESS_IDS)
        return call('PATCH', f'/v1/objects/contacts/{rid}', {'properties': {'job_title': f'Stress tester {random.randint(1, 9999)}'}})
    return run


NAME = ['name']
CONTACT_COLS = ['name', 'owner', 'first_name', 'last_name', 'email', 'phone', 'lifecycle_stage', 'job_title']
SAMPLE_IDS = {}


def sample_id(obj):
    ids = SAMPLE_IDS.get(obj)
    if not ids:
        s, _, p = call('QUERY', f'/v1/objects/{obj}/search', {'limit': 200, 'properties': NAME, 'sorts': [{'property': 'created_at', 'direction': 'desc'}]})
        ids = SAMPLE_IDS[obj] = [r['id'] for r in json.loads(p)['results']]
    return random.choice(ids)


def record_page(obj):
    def run():
        rid = sample_id(obj)
        s1, t1, _ = call('GET', f'/v1/objects/{obj}/{rid}')
        s2, t2, _ = call('GET', f'/v1/objects/{obj}/{rid}/associations')
        s3, t3, _ = call('GET', f'/v1/objects/{obj}/{rid}/history?limit=50')
        return max(s1, s2, s3) if 0 not in (s1, s2, s3) else 0, t1 + t2 + t3, b''
    return run


def global_search(q):
    # the sidebar search box asks each object at once; the user waits for the slowest
    def run():
        res = []
        ths = [threading.Thread(target=lambda o=o: res.append(call('QUERY', f'/v1/objects/{o}/search', {'query': q, 'limit': 8, 'properties': NAME})))
               for o in ('contacts', 'companies', 'deals')]
        t = time.perf_counter()
        [x.start() for x in ths]
        [x.join() for x in ths]
        return (max(r[0] for r in res) if all(r[0] for r in res) else 0), (time.perf_counter() - t) * 1000, b''
    return run


def home_counts():
    def run():
        res = []
        ths = [threading.Thread(target=lambda o=o: res.append(call('QUERY', f'/v1/objects/{o}/search', {'limit': 1, 'properties': NAME})))
               for o in ('contacts', 'companies', 'deals')]
        t = time.perf_counter()
        [x.start() for x in ths]
        [x.join() for x in ths]
        return (max(r[0] for r in res) if all(r[0] for r in res) else 0), (time.perf_counter() - t) * 1000, b''
    return run


SCENARIOS = {
    'me': lambda: call('GET', '/v1/me'),
    'home_counts': home_counts(),
    # "All contacts" sorts newest first since 2026-11-27 (it sorted by phone before)
    'contacts_table_default_view': search('contacts', limit=50, properties=CONTACT_COLS, sorts=[{'property': 'created_at', 'direction': 'desc'}],
                                          associations=[{'object': 'companies', 'properties': NAME}]),
    'contacts_filter_company_industry': search('contacts', limit=50, properties=CONTACT_COLS, sorts=[{'property': 'created_at', 'direction': 'desc'}],
                                               filter_groups=[{'filters': [{'property': 'industry', 'operator': 'contains', 'value': 'software',
                                                                            'association': {'object': 'companies'}}]}]),
    'contacts_filter_first_name_cs': search('contacts', limit=50, properties=CONTACT_COLS, sorts=[{'property': 'created_at', 'direction': 'desc'}],
                                            filter_groups=[{'filters': [{'property': 'first_name', 'operator': 'starts_with', 'value': 'chris', 'case_sensitive': True}]}]),
    'contacts_table_newest': search('contacts', limit=50, properties=CONTACT_COLS, sorts=[{'property': 'created_at', 'direction': 'desc'}],
                                    associations=[{'object': 'companies', 'properties': NAME}]),
    'contacts_table_page_100': search('contacts', limit=50, properties=CONTACT_COLS, sorts=[{'property': 'created_at', 'direction': 'desc'}],
                                      after='NTAwMA'),  # offset 5000
    'contacts_search_smith': search('contacts', query='smith', limit=50, properties=CONTACT_COLS, sorts=[{'property': 'created_at', 'direction': 'desc'}]),
    'contacts_search_rare': search('contacts', query='wright.77', limit=50, properties=CONTACT_COLS),
    'contacts_filter_owner_stage': search('contacts', limit=50, properties=CONTACT_COLS,
                                          filter_groups=[{'filters': [{'property': 'owner', 'operator': 'in', 'values': ['0000000003']},
                                                                      {'property': 'lifecycle_stage', 'operator': 'in', 'values': ['customer']}]}]),
    'companies_table_default_view': search('companies', limit=50, properties=['name', 'domain', 'industry', 'address_city'], sorts=[{'property': 'name', 'direction': 'asc'}]),
    'companies_search_acme': search('companies', query='acme', limit=50, properties=['name', 'domain']),
    'deals_table_default_view': search('deals', limit=50, properties=['name', 'amount', 'currency', 'pipeline', 'stage', 'close_date', 'owner'],
                                       sorts=[{'property': 'created_at', 'direction': 'desc'}]),
    'global_search_acme': global_search('acme'),
    'global_search_sarah': global_search('sarah'),
    'edit_contact': edit_contact(),
    'record_page_contact': record_page('contacts'),
    'record_page_company': record_page('companies'),
}

# what a typical user does, weighted
MIX = [('contacts_table_newest', 20), ('contacts_table_default_view', 10), ('contacts_search_smith', 10), ('global_search_sarah', 10),
       ('record_page_contact', 20), ('record_page_company', 10), ('deals_table_default_view', 10), ('companies_table_default_view', 5),
       ('home_counts', 5), ('contacts_filter_company_industry', 5), ('contacts_filter_first_name_cs', 5), ('edit_contact', 10)]


def pct(xs, p):
    xs = sorted(xs)
    return xs[min(len(xs) - 1, int(round(p / 100 * (len(xs) - 1))))]


def single(runs=5, only=None):
    for name, fn in SCENARIOS.items():
        if only and name not in only:
            continue
        times, statuses = [], []
        for _ in range(runs):
            s, ms, body = fn()
            times.append(ms)
            statuses.append(s)
        bad = [s for s in statuses if s != 200]
        print(f'{name:32} median {statistics.median(times):8.0f} ms  min {min(times):7.0f}  max {max(times):7.0f}' +
              (f'  ERRORS {bad} {body[:200]!r}' if bad else ''), flush=True)


def concurrent(users, seconds, think=(0.5, 2.0), warmup=0):
    names = [n for n, w in MIX for _ in range(w)]
    t0 = time.time()
    stop = t0 + warmup + seconds
    measure_from = t0 + warmup
    lock = threading.Lock()
    results = []  # (name, status, ms)

    def user():
        # spread the first actions over one think period, so users do not all start at once
        time.sleep(random.uniform(0, think[1]))
        while time.time() < stop:
            n = random.choice(names)
            started = time.time()
            s, ms, _ = SCENARIOS[n]()
            if started >= measure_from:
                with lock:
                    results.append((n, s, ms))
            time.sleep(random.uniform(*think))

    for o in ('contacts', 'companies'):
        sample_id(o)
    load_stress_ids()
    ths = [threading.Thread(target=user, daemon=True) for _ in range(users)]
    [t.start() for t in ths]
    [t.join() for t in ths]
    dur = time.time() - measure_from
    ok = [r for r in results if r[1] == 200]
    errs = [r for r in results if r[1] != 200]
    all_ms = [r[2] for r in ok]
    print(f'users={users} duration={dur:.0f}s actions={len(results)} ({len(results) / dur:.1f}/s) errors={len(errs)} '
          f'p50={pct(all_ms, 50):.0f}ms p95={pct(all_ms, 95):.0f}ms max={max(all_ms):.0f}ms' if all_ms else f'users={users} no successes, errors={len(errs)}')
    by = {}
    for n, s, ms in results:
        by.setdefault(n, []).append((s, ms))
    for n, xs in sorted(by.items()):
        good = [ms for s, ms in xs if s == 200]
        e = [s for s, _ in xs if s != 200]
        print(f'  {n:32} n={len(xs):4} p50={pct(good, 50) if good else 0:7.0f} p95={pct(good, 95) if good else 0:7.0f}' + (f' errors={sorted(set(e))}x{len(e)}' if e else ''))
    sys.stdout.flush()
    return (pct(all_ms, 95) if all_ms else float('inf')), (len(errs) / len(results) if results else 1.0)


def ramp(steps, seconds):
    # a realistic user acts about every 15 s (the README's definition of a concurrent user)
    for users in steps:
        print(f'--- {time.strftime("%H:%M:%S")} step: {users} users', flush=True)
        p95, err = concurrent(users, seconds, think=(10.0, 20.0), warmup=30)
        if p95 > 2000 or err > 0.01:
            print(f'stopped at {users} users: p95 {p95:.0f} ms, {err:.1%} failed', flush=True)
            return
    print('every step stayed under p95 2 s and 1% failures', flush=True)


if __name__ == '__main__':
    mode = sys.argv[1] if len(sys.argv) > 1 else 'single'
    if mode == 'single':
        single(only=sys.argv[2:] or None)
    elif mode == 'ramp':
        ramp([int(x) for x in sys.argv[2].split(',')], int(sys.argv[3]))
    else:
        concurrent(int(sys.argv[2]), int(sys.argv[3]))
