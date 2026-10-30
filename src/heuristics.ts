import type { Faker } from '@faker-js/faker';
import type { Schema } from './model.js';

/** Per-object context so a record's name, username, email and avatar agree with each other. */
export interface RecordContext {
  /** Property names of the object being generated. */
  siblings: Set<string>;
  /** Name of the property holding this object, e.g. `team` for `team.name`. */
  owner?: string;
  person?: { first: string; last: string };
}

export function personOf(faker: Faker, rec: RecordContext) {
  rec.person ??= { first: faker.person.firstName(), last: faker.person.lastName() };
  return rec.person;
}

/** Normalize `created_at`, `createdAt`, `Created-At` to `createdat`. */
export function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

type StringRule = [RegExp, (f: Faker, rec: RecordContext, schema: Schema) => string];

const has = (rec: RecordContext, ...names: string[]) => names.some((n) => rec.siblings.has(n));

const STRING_RULES: StringRule[] = [
  [/^(firstname|givenname|forename)$/, (f, r) => personOf(f, r).first],
  [/^(lastname|surname|familyname)$/, (f, r) => personOf(f, r).last],
  [/^(fullname|displayname|author|authorname|ownername|customername|contactname)$/, (f, r) => fullName(f, r)],
  [
    /^name$/,
    (f, r) => {
      const owner = normalizeName(r.owner ?? '');
      if (/(product|item|sku)$/.test(owner) || has(r, 'price', 'sku', 'cost', 'stock', 'inventory')) return f.commerce.productName();
      if (/(team|group|department|squad|unit)$/.test(owner)) return `${f.word.adjective()} ${f.word.noun()}`.replace(/^\w/, (c) => c.toUpperCase());
      if (/(org|organization|organisation|company|employer|account|workspace|tenant|vendor|brand)$/.test(owner)) return f.company.name();
      if (/(project|repo|repository|app|application|service)$/.test(owner)) return f.lorem.slug(2);
      if (/(category|tag|label|genre|topic)$/.test(owner)) return f.commerce.department();
      if (has(r, 'domain', 'industry', 'employees', 'website')) return f.company.name();
      return fullName(f, r);
    },
  ],
  [/^(username|login|handle|nickname|screenname)$/, (f, r) => username(f, r)],
  [/email/, (f, r) => email(f, r)],
  [/(phone|mobile|telephone|^tel$|fax)/, (f) => f.phone.number({ style: 'international' })],
  [/(avatar|profileimage|profilepicture|profilephoto)/, (f) => f.image.avatar()],
  [/(image|photo|picture|thumbnail|logo|banner|cover)(url)?$/, (f) => f.image.url({ width: 640, height: 480 })],
  [/(url|uri|website|homepage|link|href)$/, (f) => f.internet.url()],
  [/^(company|companyname|organization|organisation|employer)$/, (f) => f.company.name()],
  [/^(jobtitle|position|role|occupation)$/, (f) => f.person.jobTitle()],
  [/^(street|streetaddress|address|addressline1?|line1)$/, (f) => f.location.streetAddress()],
  [/^(addressline2|line2)$/, (f) => f.location.secondaryAddress()],
  [/^(city|town)$/, (f) => f.location.city()],
  [/^state$/, (f, r) => (has(r, 'city', 'zip', 'zipcode', 'postcode', 'postalcode', 'country') ? f.location.state() : f.helpers.arrayElement(['active', 'pending', 'inactive']))],
  [/^(province|region)$/, (f) => f.location.state()],
  [/^(zip|zipcode|postcode|postalcode)$/, (f) => f.location.zipCode()],
  [/^(countrycode|countryiso)$/, (f) => f.location.countryCode()],
  [/^country$/, (f) => f.location.country()],
  [/^(timezone|tz)$/, (f) => f.location.timeZone()],
  [/^(currency|currencycode)$/, (f) => f.finance.currencyCode()],
  [/^(locale|language|lang)$/, (f) => f.helpers.arrayElement(['en-US', 'en-GB', 'de-DE', 'fr-FR', 'es-ES', 'ja-JP'])],
  [/(color|colour)$/, (f) => f.color.human()],
  [/^(hex|hexcolor)$/, (f) => f.color.rgb()],
  [/^slug$/, (f) => f.lorem.slug(3)],
  [/^sku$/, (f) => f.string.alphanumeric({ length: 8, casing: 'upper' })],
  [/^(ip|ipaddress|ipv4)$/, (f) => f.internet.ipv4()],
  [/^ipv6$/, (f) => f.internet.ipv6()],
  [/^(domain|hostname|host)$/, (f) => f.internet.domainName()],
  [/^(useragent)$/, (f) => f.internet.userAgent()],
  [/^(password|secret)$/, (f) => f.internet.password({ length: 16 })],
  [/^(title|headline|subject)$/, (f) => sentence(f.lorem.sentence({ min: 3, max: 7 }))],
  [/^(description|summary|bio|about|excerpt)$/, (f) => f.lorem.sentences({ min: 1, max: 3 })],
  [/^(body|content|text|comment|message|note|notes)$/, (f) => f.lorem.paragraph()],
  [/^status$/, (f) => f.helpers.arrayElement(['active', 'pending', 'inactive'])],
  [/^(type|kind|category)$/, (f) => f.commerce.department().toLowerCase()],
  [/^(tag|label)$/, (f) => f.word.noun()],
  [/^(token|accesstoken|refreshtoken|apikey)$/, (f) => f.string.alphanumeric(32)],
];

/** A realistic string for this property name, or undefined when no rule applies. */
export function stringByName(f: Faker, name: string, rec: RecordContext, schema: Schema): string | undefined {
  if (isIdName(name)) return f.string.uuid();
  const n = normalizeName(name);
  for (const [re, gen] of STRING_RULES) if (re.test(n)) return gen(f, rec, schema);
  return undefined;
}

/** Whether a string property name implies a timestamp when the schema gives no `format`. */
export function looksLikeDateTime(name: string): boolean {
  return /^(timestamp|datetime|time|date)$/i.test(name) || /([a-z0-9](At|On|Date|Time|Timestamp)|_(at|on|date|time|timestamp))$/.test(name);
}

/** `id`, `userId`, `user_id`, `uuid` — but not `paid` or `valid`. */
export function isIdName(name: string): boolean {
  return /^(id|uuid|guid)$/i.test(name) || /([a-z0-9](Id|ID|Uuid)|[_-](id|uuid))$/.test(name);
}

export function looksLikeDate(name: string): boolean {
  const n = normalizeName(name);
  return /(birthday|birthdate|dob|dateofbirth)$/.test(n) || /^(date|day)$/.test(n);
}

type NumberRule = [RegExp, (f: Faker, integer: boolean) => number];

const NUMBER_RULES: NumberRule[] = [
  [/(price|amount|cost|balance|salary|fee|subtotal|tax|revenue)$/, (f, int) => (int ? f.number.int({ min: 100, max: 100_000 }) : f.number.float({ min: 1, max: 1000, fractionDigits: 2 }))],
  [/^age$/, (f) => f.number.int({ min: 18, max: 85 })],
  [/^(lat|latitude)$/, (f) => f.location.latitude()],
  [/^(lng|lon|long|longitude)$/, (f) => f.location.longitude()],
  [/^(rating|stars|score)$/, (f, int) => (int ? f.number.int({ min: 1, max: 5 }) : f.number.float({ min: 1, max: 5, fractionDigits: 1 }))],
  [/(percent|percentage|ratio)$/, (f, int) => (int ? f.number.int({ min: 0, max: 100 }) : f.number.float({ min: 0, max: 1, fractionDigits: 2 }))],
  [/^(page|pagenumber|currentpage)$/, (f) => f.number.int({ min: 1, max: 5 })],
  [/^(pagesize|perpage|limit|per)$/, (f) => f.helpers.arrayElement([10, 20, 25, 50])],
  [/^(year)$/, (f) => f.number.int({ min: 1990, max: 2026 })],
  [/(count|total|quantity|qty|stock|size|length|number)$/, (f) => f.number.int({ min: 0, max: 100 })],
];

/** A realistic number for this property name, or undefined when no rule applies. */
export function numberByName(f: Faker, name: string, integer: boolean): number | undefined {
  if (isIdName(name)) return f.number.int({ min: 1, max: 10_000 });
  if (integer && looksLikeDateTime(name)) return Math.floor(f.date.past({ years: 2 }).getTime() / 1000);
  const n = normalizeName(name);
  for (const [re, gen] of NUMBER_RULES) if (re.test(n)) return gen(f, integer);
  return undefined;
}

function fullName(f: Faker, r: RecordContext) {
  const p = personOf(f, r);
  return `${p.first} ${p.last}`;
}

function username(f: Faker, r: RecordContext) {
  const p = personOf(f, r);
  return f.internet.username({ firstName: p.first, lastName: p.last });
}

function email(f: Faker, r: RecordContext) {
  const p = personOf(f, r);
  return f.internet.email({ firstName: p.first, lastName: p.last }).toLowerCase();
}

function sentence(s: string) {
  return s.replace(/\.$/, '');
}
