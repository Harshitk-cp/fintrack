import type { PixelIconName } from "@/components/pixel-icon";

// Mirrors src/categories.ts on the server.
export const CATEGORIES = [
  { id: "food", name: "Food & dining", icon: "coffee" },
  { id: "groceries", name: "Groceries", icon: "shopping-cart" },
  { id: "transport", name: "Transport", icon: "car" },
  { id: "fuel", name: "Fuel", icon: "zap" },
  { id: "shopping", name: "Shopping", icon: "shopping-bag" },
  { id: "bills", name: "Bills & recharges", icon: "receipt" },
  { id: "subscriptions", name: "Subscriptions", icon: "reload" },
  { id: "rent", name: "Rent & home", icon: "map-pin-home" },
  { id: "health", name: "Health", icon: "heart" },
  { id: "entertainment", name: "Entertainment", icon: "gamepad" },
  { id: "travel", name: "Travel", icon: "suitcase" },
  { id: "education", name: "Education", icon: "book-open" },
  { id: "personal", name: "Personal care", icon: "human" },
  { id: "gifts", name: "Gifts & donations", icon: "gift" },
  { id: "investments", name: "Investments", icon: "trending-up" },
  { id: "family", name: "Family & friends", icon: "users" },
  { id: "income", name: "Income", icon: "wallet" },
  { id: "other", name: "Other", icon: "box" },
] as const satisfies readonly { id: string; name: string; icon: PixelIconName }[];

export type CategoryId = (typeof CATEGORIES)[number]["id"];

export const category = (id: string | null) => CATEGORIES.find((c) => c.id === id) ?? null;
export const categoryLabel = (id: string | null) => {
  const c = category(id);
  return c ? c.name : "Uncategorised";
};
