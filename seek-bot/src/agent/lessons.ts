/** Readonly platform labels for the recorded form corpus. */
const PLATFORMS: Array<[RegExp, string]> = [
  [/myworkdayjobs|workday/i, 'Workday'],
  [/oraclecloud|taleo/i, 'Oracle Recruiting'],
  [/livehire|humanforce/i, 'LiveHire'],
  [/lever\.co/i, 'Lever'],
  [/ashbyhq/i, 'Ashby'],
  [/successfactors|sapsf/i, 'SAP SuccessFactors'],
  [/pageuppeople|pageup/i, 'PageUp'],
  [/smartrecruiters/i, 'SmartRecruiters'],
  [/greenhouse/i, 'Greenhouse'],
  [/jobadder/i, 'JobAdder'],
  [/icims/i, 'iCIMS'],
  [/bamboohr/i, 'BambooHR'],
  [/workable/i, 'Workable'],
  [/teamtailor/i, 'Teamtailor'],
  [/elmotalent|elmo/i, 'ELMO'],
  [/dayforce/i, 'Dayforce'],
  [/employmenthero/i, 'Employment Hero'],
  [/zohorecruit/i, 'Zoho Recruit'],
  [/hibob/i, 'HiBob'],
  [/jazzhr|applytojob/i, 'JazzHR'],
  [/recruitee/i, 'Recruitee'],
  [/breezy/i, 'Breezy HR'],
  [/personio/i, 'Personio'],
];

/** The hiring platform behind a host, or the host itself when it is the employer's own. */
export function platformOf(host: string): string {
  return PLATFORMS.find(([pattern]) => pattern.test(host))?.[1] ?? host.toLowerCase();
}
