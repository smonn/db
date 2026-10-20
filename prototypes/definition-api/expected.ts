// PROTOTYPE, throwaway. The row types every variant must infer.

export type Equal<X, Y> = (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false;
export type Expect<T extends true> = T;

export type OrderMetadata = { gift?: boolean; note?: string };

export type User = {
  id: string;
  email: string;
  display_name: string | null;
  age: number | null;
  is_admin: boolean;
  created_at: Date;
};

export type NewUser = {
  email: string;
  id?: string;
  display_name?: string | null;
  age?: number | null;
  is_admin?: boolean;
  created_at?: Date;
};

export type Order = {
  id: bigint;
  user_id: string;
  total: string;
  quantity: number;
  weight_kg: number | null;
  rating: number | null;
  placed_on: string;
  shipped_at: Date | null;
  metadata: OrderMetadata;
  receipt_pdf: Uint8Array | null;
};

export type NewOrder = {
  user_id: string;
  total: string;
  placed_on: string;
  quantity?: number;
  weight_kg?: number | null;
  rating?: number | null;
  shipped_at?: Date | null;
  metadata?: OrderMetadata;
  receipt_pdf?: Uint8Array | null;
};

export type Session = { user_id: string; token: string; expires_at: Date };
export type NewSession = Session;
