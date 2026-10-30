export interface SentAdminEmail {
  id: string;
  subject: string;
  body: string;
  sentAt: string;
  sentBy: { name: string | null; email: string } | null;
}

export interface AdminEmailHistoryPage {
  items: SentAdminEmail[];
  nextCursor: string | null;
}
