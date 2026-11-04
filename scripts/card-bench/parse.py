"""Rule-based field sorting for raw card text (see README.md): the part an
open-source text reader leaves to us. A prototype of what api/src would do in
TypeScript if the CRM read cards without Claude.

parse(lines) takes the text lines in reading order and returns the same
fields as the Claude reader (api/src/card-scan.ts, CardFields).
"""
import re
import unicodedata

EMAIL = re.compile(r"[A-Za-z0-9._%+'-]+\s?@\s?[A-Za-z0-9-]+(?:\s?\.\s?[A-Za-z0-9-]+)+")
WEB = re.compile(r"\b(?:https?://)?(?:www\.)?([a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|ca|io|ai|co|org|net|gov|mil|us|cloud|energy|tech|uk|de))\b", re.I)
PHONE = re.compile(r"(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]*\d{3}[\s.-]*\d{4}(?:\s*(?:ext\.?|x)\s*\d+)?", re.I)
CA_POSTAL = re.compile(r"\b([A-Z]\d[A-Z])\s?(\d[A-Z]\d)\b")
US_ZIP = re.compile(r"\b(\d{5})(?:-\d{4})?\b")
US_STATES = set("AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC PR".split())
CA_PROVINCES = set("AB BC MB NB NL NS NT NU ON PE QC SK YT".split())
CITY_REGION = re.compile(r"([A-Za-zÀ-ÿ.' -]+?),?\s+([A-Z]{2})\b(?:\s+(" + CA_POSTAL.pattern[2:-2].replace("\\s?", "\\s?") + r"|\d{5}(?:-\d{4})?))?")
FAX = re.compile(r"^(?:f|fax|dsn)\b", re.I)
PHONE_LABEL = re.compile(r"(direct|mobile|cell|cell\.|tel|tél|phone|office|main|comm|shop|dsn|fax|[tmpfo])\.?\s*:?\s*$", re.I)
RANKS = re.compile(r"^(?:(?:col|lt|cdr|lt cdr|ltcol|lcol|maj|capt|cpt|gen|sgt|sgt\.? maj|msgt|cpl|adm|cmdr|dr|mr|mrs|ms|prof)\.?\s+)+", re.I)
TITLE_WORDS = re.compile(r"\b(director|directrice|manager|vp|vice president|president|ceo|cto|cfo|coo|chief|officer|engineer|architect|partner|head|lead|specialist|coordinator|executive|representative|advisor|adviser|owner|founder|consultant|analyst|sales|marketing|operations|program|account|technical|senior|principal|associate|assistant)\b", re.I)
COMPANY_WORDS = re.compile(r"\b(inc|llc|ltd|corp|corporation|group|systems|labs|technologies|solutions|analytics|logistics|instruments|robotics|sensors|data|cloud|energy|advisory|composites|shipworks|optics|armor|research|avionics|defense|navy|army|command|usmc|aerospace|aérospatiale|machine|tool|interdiction|maritime)\b", re.I)
NOISE = re.compile(r"\b(iso\s?\d|as9100|itar|cage|uei|subsidiary|registered|canada)\b", re.I)


def norm(s):
    return re.sub(r"[^a-z0-9]", "", unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode().lower())


def parse(lines):
    texts = [l["text"].strip() for l in lines if l["text"].strip()]
    out = {k: "" for k in ["first_name", "last_name", "job_title", "company", "email", "phone", "website", "address_street_1", "address_city", "address_province", "address_postalcode", "address_country"]}
    used = set()

    # email
    for i, t in enumerate(texts):
        m = EMAIL.search(t)
        if m:
            out["email"] = re.sub(r"\s", "", m.group(0)).lower().strip(".")
            break
    domain = out["email"].split("@")[1] if "@" in out["email"] else ""

    # website: a domain that is not the email
    for t in texts:
        rest = EMAIL.sub(" ", t)
        m = WEB.search(rest)
        if m:
            out["website"] = m.group(1).lower()
            break

    # phones: label, number; Direct wins, otherwise the first that is not a fax or DSN
    phones = []
    for i, t in enumerate(texts):
        for m in PHONE.finditer(t):
            label = PHONE_LABEL.search(t[: m.start()])
            phones.append(((label.group(1) if label else "").lower(), m.group(0), i))
    best = next((p for p in phones if p[0].startswith("direct")), None) or next((p for p in phones if not FAX.match(p[0] or "x") or p[0] == ""), None)
    if best:
        out["phone"] = best[1]
    for _, _, i in phones:
        used.add(i)

    # address: City, ST postal
    for i, t in enumerate(texts):
        cand = EMAIL.sub(" ", t)
        for chunk in re.split(r"\s[·|]\s", cand):
            for m in CITY_REGION.finditer(chunk):
                region = m.group(2)
                if region not in US_STATES | CA_PROVINCES:
                    continue
                postal = m.group(3) or ""
                if not postal and not re.search(r",\s*" + region + r"\b", chunk):
                    continue
                city = m.group(1).strip(" ,")
                street = ""
                # a street before the city on the same chunk
                if "," in city:
                    street, city = [s.strip() for s in city.rsplit(",", 1)]
                    if "," in street:
                        street = street  # keep "Road, Suite 400"
                elif i > 0 and re.match(r"^(\d+|po box)", texts[i - 1], re.I):
                    street = texts[i - 1]
                    used.add(i - 1)
                out.update(address_street_1=street, address_city=city, address_province=region, address_postalcode=postal.upper())
                out["address_country"] = "CA" if region in CA_PROVINCES else "US"
                used.add(i)
                break
            if out["address_city"]:
                break
        if out["address_city"]:
            break

    # what is left: name, title, company
    rest = []
    for i, t in enumerate(texts):
        if i in used or EMAIL.search(t) or (WEB.search(t) and len(t.split()) <= 2) or PHONE.search(t) or NOISE.search(t) or re.match(r"^\d", t):
            continue
        rest.append(t)

    stem = norm(domain.split(".")[0]) if domain else norm(out["website"].split(".")[0])
    local = out["email"].split("@")[0] if out["email"] else ""

    def company_score(t):
        n = norm(t)
        s = 0
        if stem and n and (n in stem or stem in n or n[:6] == stem[:6]):
            s += 3
        if COMPANY_WORDS.search(t):
            s += 1
        if TITLE_WORDS.search(t):
            s -= 1
        return s

    def name_score(t):
        words = RANKS.sub("", t).split()
        if not 2 <= len(words) <= 4 or re.search(r"\d|@", t):
            return -9
        s = 0
        parts = [norm(w) for w in words]
        if local and any(p and p[:3] in norm(local) for p in parts):
            s += 3
        if all(w[:1].isupper() for w in words):
            s += 1
        if TITLE_WORDS.search(t) or COMPANY_WORDS.search(t):
            s -= 2
        return s

    company = max(rest, key=company_score, default="")
    if company and company_score(company) > 0:
        out["company"] = company
        rest = [t for t in rest if t != company]
    # a name split over two lines (two-column and portrait cards)
    joined = rest + [f"{a} {b}" for a, b in zip(rest, rest[1:]) if len(a.split()) == 1 and len(b.split()) == 1]
    name = max(joined, key=name_score, default="")
    if name and name_score(name) > -9:
        bare = RANKS.sub("", name).split()
        out["first_name"], out["last_name"] = " ".join(bare[:-1]), bare[-1]
        rest = [t for t in rest if t not in name.split(" ") and t != name]
    titles = [t for t in rest if TITLE_WORDS.search(t)]
    if titles:
        out["job_title"] = titles[0]
    return out
