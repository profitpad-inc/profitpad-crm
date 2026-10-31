#!/usr/bin/env python3
"""Fills a ProfitPad CRM tenant with sample records for every native object,
plus associations between them, using only the public API.

Run it, paste an API key (scopes "read" and "write", or "admin"), done:
  /usr/bin/python3 scripts/generate_sample_data.py

The API must be running (cd api && npm run dev). Set PCRM_API_URL to point
somewhere other than http://127.0.0.1:3000. Every run adds a fresh set of
records; unique values (emails, domains, SKUs, numbers) carry a per-run tag so
runs never collide.
"""

import getpass
import json
import os
import random
import sys
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone

BASE_URL = os.environ.get("PCRM_API_URL", "http://127.0.0.1:3000").rstrip("/")
RUN = "%04x" % random.randrange(16 ** 4)
NOW = datetime.now(timezone.utc)

FIRST = ["Ada", "Grace", "Alan", "Katherine", "Linus", "Margaret", "Tim", "Barbara", "Dennis", "Radia",
         "Ken", "Frances", "Edsger", "Hedy", "John", "Shafi", "Donald", "Lynn", "Vint", "Joan"]
LAST = ["Lovelace", "Hopper", "Turing", "Johnson", "Torvalds", "Hamilton", "Berners-Lee", "Liskov", "Ritchie",
        "Perlman", "Thompson", "Allen", "Dijkstra", "Lamarr", "McCarthy", "Goldwasser", "Knuth", "Conway", "Cerf", "Clarke"]
COMPANY_WORDS = ["Northwind", "Contoso", "Globex", "Initech", "Umbrella", "Stark", "Wayne", "Acme", "Hooli", "Vandelay",
                 "Soylent", "Tyrell", "Cyberdyne", "Wonka", "Gringotts", "Monarch", "Pied Piper", "Aperture", "Massive", "Oscorp"]
COMPANY_SUFFIX = ["Labs", "Industries", "Systems", "Group", "Partners", "Supply", "Logistics", "Foods", "Health", "Media"]
INDUSTRIES = ["Software", "Manufacturing", "Retail", "Healthcare", "Logistics", "Finance", "Education", "Construction"]
CITIES = [("Toronto", "ON", "Canada"), ("Vancouver", "BC", "Canada"), ("Austin", "TX", "USA"), ("Denver", "CO", "USA"),
          ("Chicago", "IL", "USA"), ("Seattle", "WA", "USA"), ("Boston", "MA", "USA"), ("Calgary", "AB", "Canada")]
TITLES = ["CEO", "CFO", "Operations Manager", "Purchasing Lead", "Sales Director", "Office Manager", "Engineer", "Buyer"]
PRODUCTS = ["Widget", "Gadget", "Sprocket", "Gear", "Valve", "Bracket", "Sensor", "Panel", "Cable", "Fitting",
            "Pump", "Filter", "Hinge", "Bearing", "Switch"]
WORDS = ["follow up", "pricing", "renewal", "onboarding", "demo", "contract", "shipping", "invoice", "kickoff", "review"]

COUNTS = {
    "users": 8, "teams": 3, "companies": 25, "contacts": 100, "deals": 40, "tickets": 25, "services": 10,
    "products": 15, "quotes": 15, "invoices": 20, "payments": 20, "carts": 10, "orders": 15, "lines": 60,
    "calls": 60, "emails": 80, "notes": 50, "tasks": 50, "files": 10, "email_templates": 5, "forms": 4,
    "form_submissions": 30, "marketing_events": 6, "marketing_event_participations": 50, "object_events": 5,
    "object_event_occurrences": 40,
}


class ApiError(Exception):
    pass


def request(api_key, method, path, body=None):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(BASE_URL + path, data=data, method=method)
    req.add_header("Authorization", "Bearer " + api_key)
    if data is not None:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=60) as res:
            raw = res.read()
            return json.loads(raw) if raw else None
    except urllib.error.HTTPError as err:
        detail = err.read().decode(errors="replace")
        raise ApiError("%s %s -> %s: %s" % (method, path, err.code, detail))
    except urllib.error.URLError as err:
        raise ApiError("cannot reach %s (%s). Is the API running? (cd api && npm run dev)" % (BASE_URL, err.reason))


# ---- value helpers ----------------------------------------------------------

def iso(dt):
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")


def past(days=365):
    return NOW - timedelta(days=random.uniform(1, days), minutes=random.randint(0, 1439))


def future(days=120):
    return NOW + timedelta(days=random.uniform(1, days))


def day(dt):
    return dt.strftime("%Y-%m-%d")


def money(lo, hi):
    return round(random.uniform(lo, hi), 2)


def person():
    return random.choice(FIRST), random.choice(LAST)


def sentence(n=8):
    return " ".join(random.choice(WORDS) for _ in range(n)).capitalize() + "."


# ---- generator --------------------------------------------------------------

class Generator:
    def __init__(self, api_key):
        self.key = api_key
        self.ids = {}
        self.links = []  # (from_object, from_id, to_object, to_id, label_id)

    def call(self, method, path, body=None):
        return request(self.key, method, path, body)

    def create(self, obj, rows):
        ids = []
        for i in range(0, len(rows), 100):
            chunk = rows[i:i + 100]
            res = self.call("POST", "/v1/objects/%s/batch" % obj,
                            {"mode": "create", "inputs": [{"properties": r} for r in chunk]})
            ids.extend(r["id"] for r in res["results"])
        self.ids[obj] = ids
        print("  %-32s %4d records" % (obj, len(ids)))
        return ids

    def link(self, from_obj, from_id, to_obj, to_id, label_id=None):
        self.links.append((from_obj, from_id, to_obj, to_id, label_id))

    def link_some(self, from_obj, to_obj, lo, hi, label_id=None):
        for fid in self.ids[from_obj]:
            for tid in random.sample(self.ids[to_obj], min(len(self.ids[to_obj]), random.randint(lo, hi))):
                self.link(from_obj, fid, to_obj, tid, label_id)

    def owners(self):
        return [[u] for u in self.ids["users"]]

    def load_labels(self):
        codes = {o["api_name"]: o["object_type_id"] for o in self.call("GET", "/v1/schema")["results"]}
        labels = {}
        for l in self.call("GET", "/v1/association-labels")["results"]:
            if l["label"]:
                labels[(l["from_object_type"], l["to_object_type"], l["label"])] = l["id"]
        return lambda f, t, name: labels.get((codes[f], codes[t], name))

    def run(self):
        print("Creating records")
        label = self.load_labels()

        # people and organization
        users = []
        for i in range(COUNTS["users"]):
            f, l = person()
            users.append({"name": "%s %s" % (f, l), "first_name": f, "last_name": l,
                          "email": "%s.%s.%s%d@example.com" % (f.lower(), l.lower().replace("-", ""), RUN, i),
                          "status": "active", "timezone": "America/Toronto"})
        self.create("users", users)
        owner = lambda: random.choice(self.owners())

        self.create("teams", [{"name": n, "description": "%s team" % n} for n in ["Sales", "Support", "Operations"]])
        for uid in self.ids["users"]:
            self.link("users", uid, "teams", random.choice(self.ids["teams"]), label("users", "teams", "Team"))

        # companies and contacts
        companies = []
        for i in range(COUNTS["companies"]):
            name = "%s %s" % (random.choice(COMPANY_WORDS), random.choice(COMPANY_SUFFIX))
            city, state, country = random.choice(CITIES)
            companies.append({"name": name, "domain": "%s-%s%d.example.com" % (name.lower().replace(" ", ""), RUN, i),
                              "industry": random.choice(INDUSTRIES), "city": city, "state": state, "country": country,
                              "employee_count": random.randint(5, 5000), "annual_revenue": money(2e5, 5e7),
                              "phone": "+1 555 %03d %04d" % (random.randint(100, 999), random.randint(0, 9999)),
                              "owner": owner(), "created_at": iso(past(900))})
        self.create("companies", companies)

        contacts = []
        for i in range(COUNTS["contacts"]):
            f, l = person()
            city, state, country = random.choice(CITIES)
            contacts.append({"name": "%s %s" % (f, l), "first_name": f, "last_name": l,
                             "email": "%s.%s.%s%d@example.org" % (f.lower(), l.lower().replace("-", ""), RUN, i),
                             "phone": "+1 555 %03d %04d" % (random.randint(100, 999), random.randint(0, 9999)),
                             "job_title": random.choice(TITLES), "city": city, "state": state, "country": country,
                             "lifecycle_stage": random.choice(["lead", "mql", "sql", "opportunity", "customer", "other"]),
                             "owner": owner(), "created_at": iso(past(700))})
        self.create("contacts", contacts)
        primary_company = label("contacts", "companies", "Primary company")
        for cid in self.ids["contacts"]:
            self.link("contacts", cid, "companies", random.choice(self.ids["companies"]), primary_company)
        for a, b in zip(self.ids["contacts"][0:10:2], self.ids["contacts"][1:10:2]):
            self.link("contacts", a, "contacts", b)

        # sales pipeline
        deals = [{"name": "%s %s deal" % (random.choice(COMPANY_WORDS), random.choice(PRODUCTS)),
                  "amount": money(1e3, 2.5e5), "currency": "USD", "pipeline": "sales",
                  "stage": random.choice(["appointment_scheduled", "qualified", "proposal", "closed_won", "closed_lost"]),
                  "close_date": day(future(180) if random.random() < 0.6 else past(180)), "owner": owner(),
                  "created_at": iso(past(400))} for _ in range(COUNTS["deals"])]
        self.create("deals", deals)
        primary_deal_company = label("deals", "companies", "Primary company")
        for did in self.ids["deals"]:
            self.link("deals", did, "companies", random.choice(self.ids["companies"]), primary_deal_company)
        self.link_some("deals", "contacts", 1, 3)

        self.create("tickets", [{"name": "Issue with %s" % random.choice(PRODUCTS).lower(), "description": sentence(),
                                 "pipeline": "support",
                                 "stage": random.choice(["new", "waiting_on_contact", "waiting_on_us", "closed"]),
                                 "priority": random.choice(["low", "medium", "high"]), "owner": owner(),
                                 "created_at": iso(past(200))} for _ in range(COUNTS["tickets"])])
        self.link_some("tickets", "contacts", 1, 2)
        self.link_some("tickets", "companies", 1, 1)

        services = []
        for _ in range(COUNTS["services"]):
            start = past(300)
            services.append({"name": "%s maintenance plan" % random.choice(PRODUCTS),
                             "description": sentence(), "status": random.choice(["planned", "active", "completed", "cancelled"]),
                             "start_date": day(start), "end_date": day(start + timedelta(days=365)), "owner": owner()})
        self.create("services", services)
        self.link_some("services", "companies", 1, 1)

        # commerce
        self.create("products", [{"name": "%s %s" % (p, random.choice(["Pro", "Mini", "XL", "Classic", "Plus"])),
                                  "sku": "SKU-%s-%03d" % (RUN.upper(), i), "description": sentence(6),
                                  "price": money(5, 900), "active": random.choice(["true", "true", "false"])}
                                 for i, p in enumerate(PRODUCTS[:COUNTS["products"]])])

        self.create("quotes", [{"name": "Quote Q-%s-%03d" % (RUN.upper(), i),
                                "status": random.choice(["draft", "sent", "accepted", "rejected", "expired"]),
                                "expiration_date": day(future(60)), "amount": money(500, 1e5), "currency": "USD"}
                               for i in range(COUNTS["quotes"])])
        self.link_some("quotes", "deals", 1, 1)
        self.link_some("quotes", "contacts", 1, 1)

        self.create("invoices", [{"name": "Invoice %d" % (1000 + i), "invoice_number": "INV-%s-%04d" % (RUN.upper(), i),
                                  "status": random.choice(["draft", "open", "paid", "void", "uncollectible"]),
                                  "due_date": day(future(45)), "amount": money(200, 8e4), "currency": "USD"}
                                 for i in range(COUNTS["invoices"])])
        self.link_some("invoices", "deals", 1, 1)
        self.link_some("invoices", "companies", 1, 1)
        self.link_some("invoices", "contacts", 1, 1)

        self.create("payments", [{"name": "Payment %d" % (5000 + i), "amount": money(100, 5e4), "currency": "USD",
                                  "status": random.choice(["pending", "succeeded", "succeeded", "failed", "refunded"]),
                                  "method": random.choice(["card", "ach", "check", "cash", "other"]), "paid_at": iso(past(120))}
                                 for i in range(COUNTS["payments"])])
        for pid, iid in zip(self.ids["payments"], random.sample(self.ids["invoices"], COUNTS["payments"])):
            self.link("payments", pid, "invoices", iid)
        self.link_some("payments", "contacts", 1, 1)

        self.create("carts", [{"name": "Cart %d" % i, "status": random.choice(["open", "abandoned", "converted"]),
                               "amount": money(20, 3000), "currency": "USD"} for i in range(COUNTS["carts"])])
        self.link_some("carts", "contacts", 1, 1)

        self.create("orders", [{"name": "Order %d" % (7000 + i), "order_number": "ORD-%s-%04d" % (RUN.upper(), i),
                                "status": random.choice(["pending", "processing", "fulfilled", "cancelled"]),
                                "amount": money(50, 2e4), "currency": "USD"} for i in range(COUNTS["orders"])])
        self.link_some("orders", "contacts", 1, 1)
        self.link_some("orders", "companies", 1, 1)

        lines = []
        for _ in range(COUNTS["lines"]):
            qty = random.randint(1, 50)
            lines.append({"name": random.choice(PRODUCTS), "sku": "SKU-%s" % RUN.upper(), "quantity": qty,
                          "unit_price": money(5, 900), "discount": random.choice([0, 0, 0, money(5, 100)])})
        self.create("lines", lines)
        product_label = label("lines", "products", "Product")
        parents = ["deals", "quotes", "invoices", "orders"]
        for lid in self.ids["lines"]:
            self.link("lines", lid, "products", random.choice(self.ids["products"]), product_label)
            parent = random.choice(parents)
            self.link("lines", lid, parent, random.choice(self.ids[parent]))

        # activities
        calls = []
        for _ in range(COUNTS["calls"]):
            start = past(150)
            secs = random.randint(60, 3600)
            calls.append({"name": "%s call" % random.choice(WORDS).capitalize(),
                          "call_type": random.choice(["call", "call", "meeting"]),
                          "direction": random.choice(["inbound", "outbound"]),
                          "status": random.choice(["completed", "completed", "scheduled", "no_show", "cancelled"]),
                          "started_at": iso(start), "ended_at": iso(start + timedelta(seconds=secs)),
                          "duration_seconds": secs, "body": sentence(12), "owner": owner()})
        self.create("calls", calls)
        self.link_some("calls", "contacts", 1, 2)
        self.link_some("calls", "deals", 0, 1)

        emails = []
        for i in range(COUNTS["emails"]):
            f, l = person()
            emails.append({"name": "Re: %s" % random.choice(WORDS), "subject": "Re: %s" % random.choice(WORDS),
                           "body": "<p>%s</p>" % sentence(20), "direction": random.choice(["inbound", "outbound"]),
                           "status": random.choice(["sent", "received", "received", "bounced"]),
                           "from_address": "%s@example.org" % f.lower(), "to_addresses": "%s@example.com" % l.lower(),
                           "sent_at": iso(past(150)), "thread_id": "thread-%s-%d" % (RUN, i % 30), "owner": owner()})
        self.create("emails", emails)
        self.link_some("emails", "contacts", 1, 2)
        self.link_some("emails", "companies", 0, 1)

        self.create("notes", [{"name": "Note", "body": "**%s**\n\n%s" % (random.choice(WORDS).capitalize(), sentence(15)),
                               "owner": owner(), "created_at": iso(past(200))} for _ in range(COUNTS["notes"])])
        self.link_some("notes", "contacts", 1, 1)
        self.link_some("notes", "deals", 0, 1)

        self.create("tasks", [{"name": "%s with client" % random.choice(WORDS).capitalize(),
                               "task_type": random.choice(["todo", "call", "email"]),
                               "status": random.choice(["not_started", "in_progress", "waiting", "completed"]),
                               "priority": random.choice(["low", "medium", "high"]), "due_at": iso(future(30)),
                               "body": sentence(10), "owner": owner()} for _ in range(COUNTS["tasks"])])
        self.link_some("tasks", "contacts", 1, 1)
        self.link_some("tasks", "deals", 0, 1)

        # files and marketing
        self.create("files", [{"name": "document-%d.pdf" % i, "mime_type": "application/pdf",
                               "size_bytes": random.randint(10000, 5000000),
                               "storage_key": "sample/%s/document-%d.pdf" % (RUN, i)} for i in range(COUNTS["files"])])
        self.link_some("files", "contacts", 1, 1)
        self.link_some("files", "deals", 0, 1)

        self.create("email_templates", [{"name": "%s template" % w.capitalize(), "subject": "About your %s" % w,
                                         "body": "<p>Hi {{first_name}},</p><p>%s</p>" % sentence(12)}
                                        for w in random.sample(WORDS, COUNTS["email_templates"])])

        forms = []
        for name in ["Contact us", "Request a demo", "Newsletter signup", "Event registration"][:COUNTS["forms"]]:
            forms.append({"name": name, "description": "%s form" % name, "status": "published",
                          "definition": json.dumps({"fields": ["first_name", "last_name", "email"]})})
        self.create("forms", forms)

        subs = []
        for i in range(COUNTS["form_submissions"]):
            f, l = person()
            subs.append({"name": "Submission %d" % i, "form_id": random.choice(self.ids["forms"]),
                         "submitted_at": iso(past(90)), "page_url": "https://example.com/contact",
                         "submission_values": json.dumps({"first_name": f, "last_name": l, "email": "%s@example.org" % f.lower()})})
        self.create("form_submissions", subs)
        for sid in self.ids["form_submissions"]:
            self.link("form_submissions", sid, "forms", random.choice(self.ids["forms"]))
            self.link("form_submissions", sid, "contacts", random.choice(self.ids["contacts"]))

        events = []
        for i in range(COUNTS["marketing_events"]):
            start = future(90) if i % 2 else past(90)
            events.append({"name": "%s %s" % (random.choice(["Spring", "Summer", "Fall", "Winter"]), random.choice(["Webinar", "Summit", "Workshop"])),
                           "event_type": random.choice(["webinar", "conference", "workshop", "other"]),
                           "status": "completed" if start < NOW else "planned", "start_at": iso(start),
                           "end_at": iso(start + timedelta(hours=2)), "location": random.choice(CITIES)[0],
                           "description": sentence(10), "external_id": "evt-%s-%d" % (RUN, i)})
        self.create("marketing_events", events)

        self.create("marketing_event_participations", [
            {"name": "Participation %d" % i, "status": random.choice(["registered", "attended", "attended", "no_show", "cancelled"]),
             "registered_at": iso(past(120)), "attendance_seconds": random.randint(0, 7200)}
            for i in range(COUNTS["marketing_event_participations"])])
        for pid in self.ids["marketing_event_participations"]:
            self.link("marketing_event_participations", pid, "marketing_events", random.choice(self.ids["marketing_events"]))
            self.link("marketing_event_participations", pid, "contacts", random.choice(self.ids["contacts"]))

        keys = ["viewed_pricing", "started_trial", "downloaded_guide", "visited_portal", "opened_quote"]
        self.create("object_events", [{"name": k.replace("_", " ").capitalize(), "event_key": "%s.%s" % (k, RUN),
                                       "description": "Custom event: %s" % k.replace("_", " ")} for k in keys[:COUNTS["object_events"]]])
        self.create("object_event_occurrences", [
            {"name": "Occurrence %d" % i, "event_key": "%s.%s" % (random.choice(keys), RUN), "occurred_at": iso(past(60)),
             "event_properties": json.dumps({"page": "/pricing", "seconds": random.randint(5, 300)}), "source": "website"}
            for i in range(COUNTS["object_event_occurrences"])])
        for oid in self.ids["object_event_occurrences"]:
            self.link("object_event_occurrences", oid, "contacts", random.choice(self.ids["contacts"]))
            self.link("object_event_occurrences", oid, "object_events", random.choice(self.ids["object_events"]))

        self.associate_all()

    def associate_all(self):
        print("Creating %d associations" % len(self.links))

        def one(link):
            from_obj, from_id, to_obj, to_id, label_id = link
            body = {"label_id": label_id} if label_id else {}
            try:
                self.call("PUT", "/v1/objects/%s/%s/associations/%s/%s" % (from_obj, from_id, to_obj, to_id), body)
                return None
            except ApiError as err:
                return str(err)

        with ThreadPoolExecutor(max_workers=8) as pool:
            errors = [e for e in pool.map(one, self.links) if e]
        print("  %d created, %d failed" % (len(self.links) - len(errors), len(errors)))
        for e in errors[:5]:
            print("  failed:", e)


def main():
    print("ProfitPad CRM sample data -> %s" % BASE_URL)
    api_key = getpass.getpass("API key (input hidden): ").strip()
    if not api_key:
        print("No API key entered.")
        sys.exit(1)
    try:
        request(api_key, "GET", "/v1/schema")
        gen = Generator(api_key)
        gen.run()
    except ApiError as err:
        print("\nStopped: %s" % err)
        sys.exit(1)
    total = sum(len(v) for v in gen.ids.values())
    print("\nDone: %d records across %d objects (run tag %s)." % (total, len(gen.ids), RUN))


if __name__ == "__main__":
    main()
