export type Pilgrim = {
  id: string;
  name: string;
  phone: string;
  bus: string;
  hotel: string;
  room: string;
  grp: string;
  notes: string;
  checkin_at?: string | null;
  checkout_at?: string | null;
  created_at?: string;
  updated_at?: string;
};
export type Template = { id: string; title: string; body: string; sort: number };
