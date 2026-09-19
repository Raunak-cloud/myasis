/**
 * How many job titles one account may search for.
 *
 * One number for the form, the AI suggestions and the saved setting, so none
 * of them can offer what another refuses. seek-bot enforces the same cap in
 * its own config (MAX_SEARCH_TERMS). It applies to every account, admins
 * included: it limits search traffic, which the job boards see the same way
 * whoever is running.
 */
export const MAX_SEARCH_TERMS = 4;
