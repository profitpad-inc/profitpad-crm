#!/usr/bin/env python3
"""Fills a defense CRM tenant (the `defense` package installed) with linked demo
records, using only the public API.

  /usr/bin/python3 scripts/seed_defense_data.py

It asks for an API key (scopes "read" and "write", or "admin"); set PCRM_API_KEY
to skip the prompt. PCRM_API_URL picks the CRM (default
https://crm.defense.profitpad.com). Every run adds a fresh set of records;
unique values (SKUs, quote numbers, emails, CAGE codes) carry a per-run tag.

What it makes: 32 companies, 127 contacts, 12 deals (defense pipeline), 50
products, 10 quotes with line items, 8 partnerships, 5 OEM integrations, 5
trips, 10 expenses, 6 marketing materials, 3 BOMs with component lines, 7 intel
topics, 5 escalations, and the default opportunity sources when there are none.
Owners and other user pickers use the tenant's existing users.
"""

import getpass
import os
import random
import sys
from datetime import timedelta

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.environ.setdefault("PCRM_API_URL", "https://crm.defense.profitpad.com")
import generate_sample_data as base  # noqa: E402  (reads PCRM_API_URL on import)
from generate_sample_data import ApiError, request, iso, past, future, day, money  # noqa: E402

RUN = base.RUN
NOW = base.NOW

FIRST = ["James", "Maria", "Robert", "Linda", "Michael", "Patricia", "David", "Jennifer", "Carlos", "Aisha",
         "Kevin", "Rachel", "Brian", "Nicole", "Marcus", "Laura", "Derek", "Sofia", "Trevor", "Hannah",
         "Andre", "Megan", "Victor", "Erin", "Samuel", "Dana", "Grant", "Olivia", "Isaac", "Tara"]
LAST = ["Reyes", "Whitfield", "Okafor", "Brennan", "Castillo", "Harmon", "Lindqvist", "Nakamura", "Delgado", "Pruitt",
        "Sandoval", "Kowalski", "Ashford", "Mbeki", "Thornton", "Vasquez", "Hollis", "Garrity", "Novak", "Fairchild",
        "Banerjee", "Calloway", "Duarte", "Ellison", "Faulkner", "Gonzaga", "Hargrove", "Iverson", "Jansen", "Keller"]

# (name, customer_type, city, state, country)
COMPANIES = [
    ("Army PEO Soldier", "defense", "Fort Belvoir", "VA", "US"),
    ("Army DEVCOM C5ISR Center", "defense", "Aberdeen", "MD", "US"),
    ("Marine Corps Systems Command", "defense", "Quantico", "VA", "US"),
    ("Naval Surface Warfare Center Crane", "defense", "Crane", "IN", "US"),
    ("Air Force Research Laboratory", "defense", "Dayton", "OH", "US"),
    ("SOCOM PEO SOF Warrior", "defense", "Tampa", "FL", "US"),
    ("Joint Counter-sUAS Office", "defense", "Arlington", "VA", "US"),
    ("Defense Logistics Agency Land and Maritime", "defense", "Columbus", "OH", "US"),
    ("Canadian Army Land Equipment Program", "defense", "Ottawa", "ON", "CA"),
    ("NATO Support and Procurement Agency", "defense", "Capellen", "", "LU"),
    ("UK DE&S Land Equipment", "defense", "Bristol", "", "GB"),
    ("CBP Air and Marine Operations", "fed_civ", "Washington", "DC", "US"),
    ("DHS Science and Technology Directorate", "fed_civ", "Washington", "DC", "US"),
    ("Department of Energy Office of Security", "fed_civ", "Germantown", "MD", "US"),
    ("FAA UAS Integration Office", "fed_civ", "Washington", "DC", "US"),
    ("Texas Department of Public Safety", "state_local", "Austin", "TX", "US"),
    ("Arizona Department of Emergency Management", "state_local", "Phoenix", "AZ", "US"),
    ("Miami-Dade Police Department", "public_safety", "Miami", "FL", "US"),
    ("Los Angeles County Sheriff", "public_safety", "Los Angeles", "CA", "US"),
    ("Phoenix Fire Department", "public_safety", "Phoenix", "AZ", "US"),
    ("Ontario Provincial Police", "public_safety", "Orillia", "ON", "CA"),
    ("Halberd Aerospace", "oem", "Huntsville", "AL", "US"),
    ("Northgate Defense Systems", "oem", "Melbourne", "FL", "US"),
    ("Corvid Robotics", "oem", "San Diego", "CA", "US"),
    ("Ironwood Avionics", "oem", "Wichita", "KS", "US"),
    ("Bastion Integrated Solutions", "oem", "Reston", "VA", "US"),
    ("Sentinel Optronics", "oem", "Ottawa", "ON", "CA"),
    ("Talon Ridge Manufacturing", "oem", "Tucson", "AZ", "US"),
    ("Polaris Signal Works", "oem", "Colorado Springs", "CO", "US"),
    ("Kestrel Federal Group", "defense", "Herndon", "VA", "US"),
    ("Meridian Tactical Supply", "defense", "Fayetteville", "NC", "US"),
    ("Anvil Point Logistics", "defense", "Norfolk", "VA", "US"),
]
COMPANY_BRANCH = {"Army": "army", "Marine": "marine_corps", "Naval": "navy", "Air Force": "air_force",
                  "SOCOM": "socom", "CBP": "cbp", "DHS": "dhs"}

DEFENSE_TITLES = [("Program Manager", "LTC"), ("Contracting Officer", ""), ("Product Lead", "MAJ"),
                  ("Requirements Officer", "CPT"), ("Technical Director", ""), ("Deputy PM", "LTC"),
                  ("Test and Evaluation Lead", "MAJ"), ("Branch Chief", "COL"), ("Logistics Officer", "CPT"),
                  ("Senior Engineer", ""), ("Acquisition Specialist", "GS-13")]
CIVIL_TITLES = [("Procurement Manager", ""), ("Operations Chief", ""), ("Captain", ""), ("Lieutenant", ""),
                ("Program Analyst", "GS-12"), ("Emergency Manager", ""), ("Technology Director", "")]
OEM_TITLES = [("VP Business Development", ""), ("Director of Engineering", ""), ("Partnerships Manager", ""),
              ("Program Director", ""), ("Supply Chain Manager", ""), ("CTO", ""), ("Capture Manager", "")]
UNITS = ["1st Special Forces Group", "III Marine Expeditionary Force", "82nd Airborne Division", "PM Soldier Lethality",
         "PdM Counter-UAS", "Expeditionary Warfare Division", "Base Defense Branch", "Air and Missile Defense Cell"]
DEPARTMENTS = ["Acquisition", "Engineering", "Contracting", "Operations", "Test and Evaluation", "Logistics"]

CATEGORY_PRODUCTS = {
    "sensor": ["EO/IR Turret", "Thermal Imaging Module", "Ground Surveillance Radar", "Acoustic Detection Array",
               "RF Direction Finder", "LiDAR Perimeter Sensor", "Seismic Intrusion Sensor", "Multi-Spectral Camera",
               "Laser Rangefinder", "Passive RF Sensor", "Short-Range Radar Node", "Weather Sensing Pod", "Night Vision Core"],
    "uas": ["Group 1 Quadcopter", "Fixed-Wing ISR Drone", "VTOL Recon Aircraft", "Tethered Overwatch UAS",
            "Ground Control Station", "Launch Rail Kit", "Battery Pack 6S", "Payload Gimbal", "Mesh Radio Module",
            "Field Repair Kit", "Long-Endurance Airframe", "Nano Recon UAS", "Cargo Drone"],
    "cuas": ["RF Jammer Handheld", "Fixed Site Jammer", "Drone Detection Radar", "Kinetic Interceptor",
             "Command and Control Software", "Directional Antenna Array", "Mobile CUAS Trailer", "Spoofing Module",
             "Net Capture Launcher", "Sensor Fusion Server", "Vehicle-Mounted CUAS Kit", "Operator Tablet Kit"],
    "contract_manufacturing": ["Machined Housing", "Cable Harness Assembly", "PCB Assembly", "Ruggedized Enclosure",
                               "Composite Panel", "Mounting Bracket Set", "Sealed Connector Kit", "Thermal Shroud",
                               "Antenna Mast", "Shock Isolation Mount", "Custom Fabrication Lot", "Paint and Finish Service"],
}
COMPLIANCE = ["MIL-STD-810H", "MIL-STD-461G", "IP67", "NDAA Section 848 compliant", "TAA compliant", "ITAR controlled",
              "Berry Amendment", "Blue UAS listed"]
COUNTRIES = ["USA", "USA", "USA", "Canada", "United Kingdom"]
LEAD_TIMES = ["2 to 4 weeks", "4 to 6 weeks", "6 to 8 weeks", "8 to 12 weeks", "12 to 16 weeks", "In stock"]

DEAL_STAGES = ["initial_discussion", "rfx_posted", "in_review", "with_partner", "proposal_submitted",
               "customer_review", "awarded", "lost", "initial_discussion", "proposal_submitted", "in_review", "customer_review"]
OPEN_STAGES = {"initial_discussion", "rfx_posted", "in_review", "with_partner", "proposal_submitted", "customer_review"}
NEXT_STEPS = ["Send updated spec sheet", "Schedule live demo", "Submit questions to contracting officer",
              "Confirm funding line with PM", "Arrange site visit", "Deliver pricing for option years",
              "Get teaming agreement signed", "Follow up after industry day", "Prepare technical volume"]
DEAL_DESCRIPTIONS = ["Base defense requirement for layered detection and defeat.", "Replacement of legacy sensors at forward sites.",
                     "Pilot program for small unit ISR.", "Border surveillance expansion along the southwest sector.",
                     "Training and spares package for fielded systems.", "Rapid fielding under an OTA prototype agreement."]

PARTNER_NAMES = ["teaming", "var", "technology", "distribution", "strategic_alliance", "var", "teaming", "technology"]
DESTINATIONS = [("AUSA Annual Meeting", "Washington, DC", "DCA"), ("SOF Week", "Tampa, FL", "TPA"),
                ("Modern Day Marine", "Washington, DC", "DCA"), ("Eurosatory", "Paris, France", "CDG"),
                ("Site visit and demo", "Fort Bliss, TX", "ELP")]
VENDORS = {"airfare": ["United Airlines", "Delta", "American Airlines", "Air Canada"],
           "hotel": ["Marriott", "Hilton", "Hyatt"], "meals": ["Client dinner", "Per diem meals", "Conference lunch"],
           "ground": ["Uber", "Hertz", "Enterprise"], "registration": ["Event registration"],
           "shipping": ["FedEx", "UPS"], "other": ["Office Depot"]}
MATERIALS = [("slick_sheet", "CUAS Product Slick Sheet", "cuas", "Product sheets"),
             ("product_presentation", "UAS Family Briefing Deck", "uas", "Presentations"),
             ("company_presentation", "Company Capabilities Overview", "sensor", "Presentations"),
             ("linkedin_post", "Trade Show Recap Post", "uas", "Social"),
             ("event_support", "Booth Banner and Handouts", "cuas", "Events"),
             ("case_study", "Border Surveillance Case Study", "sensor", "Case studies")]
INTEL = [("topic", "Counter-UAS funding", "counter UAS budget FY27"),
         ("topic", "Blue UAS list updates", "DIU Blue UAS cleared list"),
         ("competitor", "Competitor: Vantage Shield", "Vantage Shield counter drone contract"),
         ("competitor", "Competitor: Skyhold Systems", "Skyhold Systems award"),
         ("tender", "NSPA sensor tenders", "NSPA tender surveillance sensor"),
         ("tender", "SAM.gov CUAS solicitations", "SAM.gov counter-UAS RFP"),
         ("company", "Kestrel Federal Group", "Kestrel Federal Group contract")]
ROADBLOCKS = ["need_nda", "need_specs", "customer_questions", "pricing_approval", "legal_review", "budget_confirmation",
              "need_decision_maker", "clearance_export", "teaming_agreement", "demo_required"]


def slug(s):
    return "".join(c for c in s.lower() if c.isalnum())


def phone():
    # 555-0100 to 555-0199 is the range reserved for fictional use
    return "+1 %s 555 %04d" % (random.choice(["202", "703", "571", "410", "813", "256", "619", "512"]), random.randint(100, 199))


class Seeder(base.Generator):
    def __init__(self, api_key):
        super().__init__(api_key)
        self.users = []

    def load_users(self):
        res = self.call("GET", "/v1/objects/users?limit=100")
        self.users = [r["id"] for r in res.get("results", [])]
        print("  using %d existing users as owners" % len(self.users))

    def user(self):
        return [random.choice(self.users)] if self.users else None

    def users_some(self, lo, hi):
        if not self.users:
            return None
        return random.sample(self.users, min(len(self.users), random.randint(lo, hi)))

    def with_owner(self, row, key="owner"):
        u = self.user()
        if u:
            row[key] = u
        return row

    def run(self):
        print("Creating records")
        label = self.load_labels()
        self.load_users()

        # companies
        companies = []
        for i, (name, ctype, city, state, country) in enumerate(COMPANIES):
            row = {"name": name, "domain": "%s-%s.example.com" % (slug(name)[:24], RUN),
                   "customer_type": ctype, "address_city": city, "address_country": country,
                   "cage_code": "%s%03d" % (RUN.upper()[:2], i), "uei": "%s%08d" % (RUN.upper(), random.randrange(10 ** 8)),
                   "phone": phone(), "created_at": iso(past(700))}
            if state:
                row["address_province"] = state
            companies.append(self.with_owner(row))
        company_ids = self.create("companies", companies)

        # contacts: one per company first, then ~70 spread, the rest with no company
        n_contacts = 127
        company_of = []  # index into COMPANIES or None
        for i in range(n_contacts):
            if i < len(COMPANIES):
                company_of.append(i)
            elif i < 102:
                company_of.append(random.randrange(len(COMPANIES)))
            else:
                company_of.append(None)
        contacts = []
        for i, ci in enumerate(company_of):
            f, l = random.choice(FIRST), random.choice(LAST)
            ctype = COMPANIES[ci][1] if ci is not None else random.choice(["defense", "oem", "public_safety", "fed_civ", "state_local"])
            titles = DEFENSE_TITLES if ctype == "defense" else OEM_TITLES if ctype == "oem" else CIVIL_TITLES
            title, rank = random.choice(titles)
            row = {"first_name": f, "last_name": l,
                   "email": "%s.%s.%s%d@example.org" % (f.lower(), l.lower(), RUN, i), "phone": phone(),
                   "job_title": title, "customer_type": ctype, "department": random.choice(DEPARTMENTS),
                   "linkedin_url": "https://www.linkedin.com/in/%s-%s-%s%d" % (f.lower(), l.lower(), RUN, i),
                   "created_at": iso(past(600))}
            if rank:
                row["rank"] = rank
            if ci is not None:
                cname = COMPANIES[ci][0]
                for key, branch in COMPANY_BRANCH.items():
                    if key in cname:
                        row["branch"] = branch
                if ctype == "defense" and random.random() < 0.5:
                    row["command_unit"] = random.choice(UNITS)
            contacts.append(self.with_owner(row))
        contact_ids = self.create("contacts", contacts)
        contacts_by_company = {i: [] for i in range(len(COMPANIES))}
        for cid, ci in zip(contact_ids, company_of):
            if ci is not None:
                contacts_by_company[ci].append(cid)
                self.link("contacts", cid, "companies", company_ids[ci])

        # deals: exactly one company each, 1 to 3 of its contacts, the first as point of contact
        deal_company = random.sample([i for i, c in enumerate(COMPANIES) if c[1] != "oem"], 12)
        deals = []
        for n, (ci, stage) in enumerate(zip(deal_company, DEAL_STAGES)):
            cname, ctype = COMPANIES[ci][0], COMPANIES[ci][1]
            category = random.choice(list(CATEGORY_PRODUCTS))
            b = [random.randint(5, 25) for _ in range(4)]
            closed = stage in ("awarded", "lost")
            row = {"name": "%s %s" % (cname, random.choice(CATEGORY_PRODUCTS[category])),
                   "pipeline": "defense", "stage": stage, "currency": "USD",
                   "amount": random.choice([money(8e4, 5e5), money(5e5, 3e6), money(1e6, 8e6)]),
                   "close_date": day(past(90) if closed else future(300)),
                   "customer_type": ctype, "product_category": category,
                   "contract_vehicle": random.choice(["rfi", "rfq", "sole_source", "idiq", "bpa", "gsa_schedule", "other"]),
                   "region": "europe" if COMPANIES[ci][4] in ("LU", "GB") else "noram",
                   "solicitation_number": "W%s-%02d-R-%04d" % (RUN.upper(), 26 + n % 2, random.randrange(10000)),
                   "bant_budget": b[0], "bant_authority": b[1], "bant_need": b[2], "bant_timeline": b[3],
                   "pwin": 100 if stage == "awarded" else 0 if stage == "lost" else sum(b),
                   "description": random.choice(DEAL_DESCRIPTIONS), "created_at": iso(past(240))}
            if not closed:
                row["next_step"] = random.choice(NEXT_STEPS)
                row["next_step_date"] = day(future(30))
            if stage == "lost":
                row["loss_reason"] = random.choice(["price", "incumbent", "no_funding", "technical"])
                row["loss_notes"] = "Customer went with the incumbent on price and schedule."
            deals.append(self.with_owner(row))
        deal_ids = self.create("deals", deals)
        poc = label("deals", "contacts", "Point of contact")
        deal_contacts = {}
        for did, ci in zip(deal_ids, deal_company):
            self.link("deals", did, "companies", company_ids[ci])
            pool = contacts_by_company[ci]
            chosen = random.sample(pool, min(len(pool), random.randint(1, 3)))
            deal_contacts[did] = chosen
            for k, cid in enumerate(chosen):
                self.link("deals", did, "contacts", cid, poc if k == 0 else None)

        # products
        products, product_cat, product_price = [], [], []
        n = 0
        cats = list(CATEGORY_PRODUCTS)
        while len(products) < 50:
            cat = cats[n % len(cats)]
            names = CATEGORY_PRODUCTS[cat]
            pname = names[(n // len(cats)) % len(names)]
            msrp = money(400, 90000) if cat != "contract_manufacturing" else money(40, 6000)
            row = {"name": pname, "sku": "DEF-%s-%03d" % (RUN.upper(), n), "product_category": cat,
                   "description": "%s for field use, built for rugged environments." % pname,
                   "unit_price": msrp, "unit_cost": round(msrp * random.uniform(0.45, 0.7), 2),
                   "msrp": msrp, "gsa_price": round(msrp * 0.92, 2), "distributor_price": round(msrp * 0.8, 2),
                   "price_effective_date": day(past(120)), "price_expiry_date": day(future(365)),
                   "berry_compliant": random.choice(["yes", "yes", "no", "na"]),
                   "country_of_origin": random.choice(COUNTRIES), "lead_time": random.choice(LEAD_TIMES),
                   "target_margin": random.choice([25, 30, 35, 40]),
                   "specifications": "- Operating temperature: -32 to 55 C\n- Weight: %.1f kg\n- Power: %d W" % (random.uniform(0.5, 40), random.randint(10, 400)),
                   "key_features": "- Fast setup\n- Open architecture\n- Low power draw",
                   "compliance_standards": "\n".join("- " + c for c in random.sample(COMPLIANCE, 3)),
                   "active": "true"}
            products.append(row)
            product_cat.append(cat)
            product_price.append(msrp)
            n += 1
        product_ids = self.create("products", products)

        # quotes: 10, each to one deal; three deals carry 2 or 3 quotes
        quote_deals = [deal_ids[0]] * 3 + [deal_ids[1]] * 2 + [deal_ids[2]] * 2 + random.sample(deal_ids[3:], 3)
        statuses = ["draft", "sent", "accepted", "rejected", "sent", "draft", "accepted", "sent", "rejected", "sent"]
        quotes, quote_lines = [], []
        for i, (did, status) in enumerate(zip(quote_deals, statuses)):
            picks = random.sample(range(len(product_ids)), random.randint(2, 4))
            lines = []
            for p in picks:
                lines.append({"name": products[p]["name"], "sku": products[p]["sku"], "quantity": random.randint(1, 20),
                              "unit_price": product_price[p], "berry_compliant": products[p]["berry_compliant"],
                              "lead_time": products[p]["lead_time"], "country_of_origin": products[p]["country_of_origin"],
                              "_product": product_ids[p]})
            total = round(sum(l["quantity"] * l["unit_price"] for l in lines), 2)
            quote_lines.append(lines)
            quotes.append(({
                "name": "Quote Q-%s-%03d" % (RUN.upper(), i), "status": "sent" if status == "accepted" else status, "currency": "USD", "amount": total,
                "expiration_date": day(future(60)),
                "customer_type": deals[deal_ids.index(did)]["customer_type"],
                "price_list": random.choice(["msrp", "gsa", "distributor"]),
                "payment_terms": random.choice(["net_30", "net_45", "net_60"]),
                "lead_time": random.choice(LEAD_TIMES), "berry_compliant": random.choice(["yes", "na"]),
                "country_of_origin": "USA", "ship_units": "in_lb",
                "ship_length": random.randint(12, 48), "ship_width": random.randint(12, 36),
                "ship_height": random.randint(8, 30), "ship_weight": random.randint(10, 300),
                "est_freight": money(150, 2500), "notes_terms": "Prices valid for 60 days. FOB origin."}))
        quote_ids = self.create("quotes", quotes)
        line_rows, line_parent = [], []
        for qid, lines in zip(quote_ids, quote_lines):
            for l in lines:
                line_parent.append((qid, l.pop("_product")))
                line_rows.append(l)
        line_ids = self.create("lines", line_rows)
        for lid, (qid, pid) in zip(line_ids, line_parent):
            self.link("lines", lid, "quotes", qid)
            self.link("lines", lid, "products", pid)
        for qid, did in zip(quote_ids, quote_deals):
            self.link("quotes", qid, "deals", did)
            ci = deal_company[deal_ids.index(did)]
            self.link("quotes", qid, "companies", company_ids[ci])
            if deal_contacts[did]:
                self.link("quotes", qid, "contacts", deal_contacts[did][0])

        # partnerships with partner companies (OEMs and primes)
        partner_pool = [i for i, c in enumerate(COMPANIES) if c[1] == "oem" or c[0] in ("Kestrel Federal Group", "Meridian Tactical Supply", "Anvil Point Logistics")]
        partner_cos = random.sample(partner_pool, 8)
        partnerships = []
        for ci, ptype in zip(partner_cos, PARTNER_NAMES):
            status = random.choice(["active", "active", "pursuing", "prospecting", "on_hold"])
            agreement = {"var": "reseller_agreement", "teaming": "teaming_agreement"}.get(ptype, random.choice(["nda", "mou", "none"]))
            row = {"name": "%s %s" % (COMPANIES[ci][0], ptype.replace("_", " ")), "partner_type": ptype,
                   "product_category": random.choice(cats), "status": status, "agreement_type": agreement,
                   "rationale": "Extends our reach into programs where they hold the prime contract.",
                   "value_to_us": "Access to contract vehicles and existing customer relationships.",
                   "value_to_partner": "Proven sensors and CUAS products to round out their offering.",
                   "gaps_addressed": "Integration support and regional sales coverage.",
                   "still_needed": "Joint pricing model and a signed teaming agreement." if status != "active" else "Quarterly pipeline review."}
            if status == "active":
                row["agreement_date"] = day(past(400))
                row["renewal_date"] = day(future(300))
            partnerships.append(self.with_owner(row))
        partnership_ids = self.create("partnerships", partnerships)
        partner_label = label("partnerships", "companies", "Partner company")
        for i, (pid, ci) in enumerate(zip(partnership_ids, partner_cos)):
            self.link("partnerships", pid, "companies", company_ids[ci], partner_label)
            self.link("partnerships", pid, "contacts", contacts_by_company[ci][0])
            if i % 2 == 0:
                self.link("partnerships", pid, "deals", random.choice(deal_ids))

        # OEM integrations: each to one deal
        oem_deals = random.sample(deal_ids, 5)
        oem_cos = random.sample([i for i, c in enumerate(COMPANIES) if c[1] == "oem"], 5)
        oems = []
        for did, ci in zip(oem_deals, oem_cos):
            f, l = random.choice(FIRST), random.choice(LAST)
            itype = random.choice(["software", "hardware", "data", "api", "manufacturing"])
            oems.append(self.with_owner({
                "name": "%s %s integration" % (COMPANIES[ci][0], itype), "integration_type": itype,
                "status": random.choice(["scoping", "in_development", "testing", "active", "on_hold"]),
                "priority": random.choice(["high", "medium", "low"]),
                "target_completion": day(future(150)), "go_live_date": day(future(220)),
                "contact_name": "%s %s" % (f, l), "contact_email": "%s.%s.%s@example.com" % (f.lower(), l.lower(), RUN),
                "description": "Integrate our detection feed into their command and control stack.",
                "value_proposition": "One operator picture for detection and defeat.",
                "next_steps": "Exchange ICDs and schedule a lab integration week.",
                "notes": "Export review needed before sharing source data."}))
        oem_ids = self.create("oem_integrations", oems)
        for oid, did, ci in zip(oem_ids, oem_deals, oem_cos):
            self.link("oem_integrations", oid, "deals", did)
            self.link("oem_integrations", oid, "companies", company_ids[ci])

        # trips and expenses
        trips = []
        for i, (event, dest, airport) in enumerate(DESTINATIONS):
            start = future(120) if i % 2 else past(60)
            end = start + timedelta(days=random.randint(2, 5))
            status = "completed" if start < NOW else random.choice(["planning", "pending_approval", "approved"])
            row = {"name": "%s trip" % event, "destination": dest, "purpose": "%s: meetings with customers and partners." % event,
                   "status": status, "start_date": day(start), "end_date": day(end),
                   "est_airfare": money(400, 1800), "est_hotel": money(600, 2400), "est_meals": money(150, 500), "est_other": money(50, 400),
                   "outbound_from": "BWI", "outbound_to": airport, "outbound_at": iso(start.replace(hour=13, minute=0)),
                   "outbound_flight": "UA %d" % random.randint(100, 2999),
                   "return_from": airport, "return_to": "BWI", "return_at": iso(end.replace(hour=20, minute=0)),
                   "return_flight": "UA %d" % random.randint(100, 2999),
                   "hotel_name": random.choice(VENDORS["hotel"]) + " " + dest.split(",")[0],
                   "check_in": day(start), "check_out": day(end)}
            self.with_owner(row)
            if self.users:
                row["travel_poc"] = self.user()
                row["approver"] = self.user()
            if status in ("approved", "completed"):
                row["approved_date"] = day(start - timedelta(days=14))
            trips.append(row)
        trip_ids = self.create("trips", trips)
        for i, tid in enumerate(trip_ids):
            if i % 2 == 0:
                did = random.choice(deal_ids)
                self.link("trips", tid, "deals", did)
                for cid in deal_contacts[did][:1]:
                    self.link("trips", tid, "contacts", cid)

        expenses, expense_trip = [], []
        for i in range(10):
            t = i % len(trip_ids)
            cat = random.choice(list(VENDORS))
            expense_trip.append(trip_ids[t])
            expenses.append(self.with_owner({
                "name": "%s: %s" % (cat.capitalize(), trips[t]["name"]), "amount": money(25, 1500),
                "expense_date": trips[t]["start_date"], "category": cat, "vendor": random.choice(VENDORS[cat]),
                "notes": "Receipt to follow."}))
        expense_ids = self.create("expenses", expenses)
        for eid, tid in zip(expense_ids, expense_trip):
            self.link("expenses", eid, "trips", tid)

        # marketing materials
        mats = [self.with_owner({"name": title, "material_type": mtype, "product_category": cat,
                                 "description": "%s for the %s line." % (title, cat.upper())})
                for mtype, title, cat, folder in MATERIALS]
        mat_ids = self.create("marketing_materials", mats)
        for mid, (_, _, cat, _) in zip(mat_ids, MATERIALS):
            same = [pid for pid, c in zip(product_ids, product_cat) if c == cat]
            for pid in random.sample(same, random.randint(1, 2)):
                self.link("marketing_materials", mid, "products", pid)

        # BOMs: three, each for one product, with component lines
        bom_products = random.sample([i for i, c in enumerate(product_cat) if c != "contract_manufacturing"], 3)
        cm = [i for i, c in enumerate(product_cat) if c == "contract_manufacturing"]
        boms, bom_lines = [], []
        for p in bom_products:
            comps = []
            for _ in range(random.randint(4, 6)):
                c = random.choice(cm)
                comps.append({"name": products[c]["name"], "sku": products[c]["sku"], "quantity": random.randint(1, 8),
                              "unit_price": products[c]["unit_cost"], "_product": product_ids[c]})
            cogs = round(sum(x["quantity"] * x["unit_price"] for x in comps), 2)
            bom_lines.append(comps)
            boms.append({"name": "%s BOM" % products[p]["name"], "product_category": product_cat[p],
                         "total_cogs": cogs, "target_margin": random.choice([30, 35, 40]),
                         "notes": "Rev B. Costs from current supplier quotes."})
        bom_ids = self.create("boms", boms)
        rows, parents = [], []
        for bid, comps in zip(bom_ids, bom_lines):
            for x in comps:
                parents.append((bid, x.pop("_product")))
                rows.append(x)
        comp_ids = self.create("lines", rows)
        self.ids["lines"] = line_ids + comp_ids
        for lid, (bid, pid) in zip(comp_ids, parents):
            self.link("lines", lid, "boms", bid)
            self.link("lines", lid, "products", pid)
        for bid, p in zip(bom_ids, bom_products):
            self.link("boms", bid, "products", product_ids[p])

        # intel topics
        self.create("intel_topics", [{"name": name, "topic_type": t, "query": q} for t, name, q in INTEL])

        # escalations on open deals
        open_deals = [did for did, d in zip(deal_ids, deals) if d["stage"] in OPEN_STAGES]
        esc_deals = random.sample(open_deals, min(5, len(open_deals)))
        escs = []
        for did in esc_deals:
            rb = random.sample(ROADBLOCKS, random.randint(1, 3))
            row = {"name": "Red Star: %s" % deals[deal_ids.index(did)]["name"], "roadblocks": rb,
                   "status": random.choice(["open", "open", "in_progress", "resolved"]),
                   "notes": "Blocked until this is cleared. Need help from leadership this week."}
            self.with_owner(row)
            nu = self.users_some(1, 3)
            if nu:
                row["notified_users"] = nu
            escs.append(row)
        esc_ids = self.create("escalations", escs)
        for eid, did in zip(esc_ids, esc_deals):
            self.link("escalations", eid, "deals", did)

        # opportunity sources: the package seeds them; add the defaults only if there are none
        existing = self.call("GET", "/v1/objects/opportunity_sources?limit=1").get("results", [])
        if existing:
            print("  %-32s skipped (already has records)" % "opportunity_sources")
        else:
            self.create("opportunity_sources", default_sources())

        self.associate_all()

        # an accepted quote's line items are locked, so quotes are accepted only after their lines are on
        accepted = [qid for qid, st in zip(quote_ids, statuses) if st == "accepted"]
        for qid in accepted:
            self.call("PATCH", "/v1/objects/quotes/%s" % qid, {"properties": {"status": "accepted"}})
        print("  %d quotes marked accepted" % len(accepted))


def default_sources():
    import json
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "api", "packages", "defense", "manifest.json")
    with open(path) as f:
        manifest = json.load(f)
    return [r["values"] for r in manifest["records"] if r["object"] == "opportunity_sources"]


def main():
    print("Defense CRM sample data -> %s" % base.BASE_URL)
    api_key = os.environ.get("PCRM_API_KEY") or getpass.getpass("API key (input hidden): ").strip()
    if not api_key:
        print("No API key entered.")
        sys.exit(1)
    try:
        objects = {o["api_name"] for o in request(api_key, "GET", "/v1/schema")["results"]}
        missing = {"partnerships", "oem_integrations", "trips", "expenses", "boms", "escalations"} - objects
        if missing:
            print("This CRM does not have the defense package installed (missing: %s)." % ", ".join(sorted(missing)))
            sys.exit(1)
        gen = Seeder(api_key)
        gen.run()
    except ApiError as err:
        print("\nStopped: %s" % err)
        sys.exit(1)
    total = sum(len(v) for v in gen.ids.values())
    print("\nDone: %d records across %d objects (run tag %s)." % (total, len(gen.ids), RUN))


if __name__ == "__main__":
    main()
