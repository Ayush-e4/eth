// What the booking agents answer (SkyHop and StayWise management routes), as the desk reads it.

export interface ChangeOptionWire {
  quoteKey: string;
  note: string;
  currency: string;
  changeTotal?: string; // flights
  penalty?: string;
  total?: number; // hotels
  priceDifferencePercent?: number;
}
export interface ChangeOptions {
  current: unknown;
  options: ChangeOptionWire[];
  changeFeeUsdc: number;
  pay: { task: string; skill: string; input: unknown };
}
export interface CancelQuote {
  quoteId: string;
  refund: string;
  currency: string;
  paid: string;
  paidCurrency: string;
}
export interface HotelNow {
  // a hotel booking as StayWise reports it now
  status?: string;
  hotelName?: string;
  checkin?: string;
  checkout?: string;
}
export interface HotelView {
  booking: { total?: number; currency?: string };
  cancelFeeNow: number;
}
