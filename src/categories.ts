// Spending categories and the built-in merchant keywords that fill them in.
// Anything not matched here (or by a user's payee rule) goes to the review queue.

export const CATEGORIES = [
  { id: "food", name: "Food & dining" },
  { id: "groceries", name: "Groceries" },
  { id: "transport", name: "Transport" },
  { id: "fuel", name: "Fuel" },
  { id: "shopping", name: "Shopping" },
  { id: "bills", name: "Bills & recharges" },
  { id: "subscriptions", name: "Subscriptions" },
  { id: "rent", name: "Rent & home" },
  { id: "health", name: "Health" },
  { id: "entertainment", name: "Entertainment" },
  { id: "travel", name: "Travel" },
  { id: "education", name: "Education" },
  { id: "personal", name: "Personal care" },
  { id: "gifts", name: "Gifts & donations" },
  { id: "investments", name: "Investments" },
  { id: "family", name: "Family & friends" },
  { id: "income", name: "Income" },
  { id: "other", name: "Other" },
] as const;

export type Category = (typeof CATEGORIES)[number]["id"];
export const CATEGORY_IDS = CATEGORIES.map((c) => c.id) as [Category, ...Category[]];
export const categoryName = (id: string | null) => CATEGORIES.find((c) => c.id === id)?.name ?? null;

// Matched against the payee name and UPI ID with everything but letters and
// digits removed, so "SWIGGYI14242463" and "paytm-swiggy@axl" both hit "swiggy".
// Keywords are brand names long enough not to occur inside ordinary words.
const KEYWORDS: [Category, string[]][] = [
  ["food", ["swiggy", "zomato", "eatsure", "eatfit", "dominos", "mcdonald", "burgerking", "kfc", "pizzahut", "starbucks", "chaayos", "thirdwave", "bluetokai", "haldiram", "subway", "restaurant", "cafe", "biryani", "bakery"]],
  ["groceries", ["zepto", "blinkit", "grofers", "bigbasket", "instamart", "dmart", "jiomart", "naturesbasket", "moreretail", "spencers", "ratnadeep", "countrydelight", "milkbasket", "supermarket"]],
  ["transport", ["uber", "olacabs", "anitechnologies", "rapido", "nammayatri", "bluesmart", "bmrcl", "delhimetro", "metrorail", "fastag", "parking", "yulu"]],
  ["fuel", ["indianoil", "iocl", "hpcl", "hindustanpetroleum", "bpcl", "bharatpetroleum", "shellindia", "nayaraenergy", "fuelstation", "petrol"]],
  ["shopping", ["amazon", "flipkart", "myntra", "ajio", "meesho", "nykaa", "tatacliq", "decathlon", "ikea", "croma", "reliancedigital", "lenskart", "uniqlo"]],
  ["bills", ["airtel", "jiopay", "reliancejio", "vodafone", "bescom", "tatapower", "adanielectricity", "electricity", "actfibernet", "hathway", "tataplay", "bbps", "billdesk", "recharge", "gasbill", "indane", "bharatgas", "hpgas"]],
  ["subscriptions", ["netflix", "spotify", "primevideo", "hotstar", "jiocinema", "youtubepremium", "googleplay", "applecom", "appleservices", "icloud", "openai", "anthropic", "claudeai", "github", "notion", "zee5", "sonyliv"]],
  ["rent", ["nobroker", "nestaway", "housingcom", "magicbricks", "society", "maintenance"]],
  ["health", ["apollo", "pharmeasy", "netmeds", "tata1mg", "medplus", "practo", "cultfit", "curefit", "hospital", "clinic", "pharmacy", "diagnostic"]],
  ["entertainment", ["bookmyshow", "pvr", "inox", "cinepolis", "steam", "playstation"]],
  ["travel", ["makemytrip", "goibibo", "cleartrip", "easemytrip", "ixigo", "irctc", "redbus", "abhibus", "indigo", "airindia", "akasaair", "spicejet", "vistara", "oyorooms", "airbnb", "bookingcom"]],
  ["education", ["udemy", "coursera", "byjus", "unacademy", "school", "college", "university"]],
  ["personal", ["urbancompany", "salon"]],
  ["investments", ["zerodha", "groww", "upstox", "kuvera", "paytmmoney", "smallcase", "indianclearing", "mutualfund"]],
];

const compact = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Category for a payee from the built-in keyword list, or null. */
export function builtinCategory(...texts: (string | null | undefined)[]): Category | null {
  const hay = texts.filter(Boolean).map((t) => compact(t!)).join(" ");
  if (!hay) return null;
  for (const [cat, words] of KEYWORDS) if (words.some((w) => hay.includes(w))) return cat;
  return null;
}

/** The needs / wants / savings split used by Insights. Uncategorised spending is shown on its own. */
export const BUCKET: Record<string, "needs" | "wants" | "savings"> = {
  rent: "needs", bills: "needs", groceries: "needs", health: "needs", transport: "needs", fuel: "needs", education: "needs", family: "needs",
  food: "wants", shopping: "wants", entertainment: "wants", travel: "wants", personal: "wants", gifts: "wants", subscriptions: "wants", other: "wants",
  investments: "savings",
};
