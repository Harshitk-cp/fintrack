// Mirrors src/categories.ts on the server.
export const CATEGORIES = [
  { id: "food", name: "Food & dining", emoji: "🍽️" },
  { id: "groceries", name: "Groceries", emoji: "🛒" },
  { id: "transport", name: "Transport", emoji: "🚕" },
  { id: "fuel", name: "Fuel", emoji: "⛽" },
  { id: "shopping", name: "Shopping", emoji: "🛍️" },
  { id: "bills", name: "Bills & recharges", emoji: "🧾" },
  { id: "subscriptions", name: "Subscriptions", emoji: "🔁" },
  { id: "rent", name: "Rent & home", emoji: "🏠" },
  { id: "health", name: "Health", emoji: "💊" },
  { id: "entertainment", name: "Entertainment", emoji: "🎬" },
  { id: "travel", name: "Travel", emoji: "✈️" },
  { id: "education", name: "Education", emoji: "📚" },
  { id: "personal", name: "Personal care", emoji: "💇" },
  { id: "gifts", name: "Gifts & donations", emoji: "🎁" },
  { id: "investments", name: "Investments", emoji: "📈" },
  { id: "family", name: "Family & friends", emoji: "👪" },
  { id: "income", name: "Income", emoji: "💰" },
  { id: "other", name: "Other", emoji: "📦" },
] as const;

export type CategoryId = (typeof CATEGORIES)[number]["id"];

export const category = (id: string | null) => CATEGORIES.find((c) => c.id === id) ?? null;
export const categoryLabel = (id: string | null) => {
  const c = category(id);
  return c ? `${c.emoji} ${c.name}` : "Uncategorised";
};
