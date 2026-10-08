/**
 * The header an environment sends its reporting token in when it calls
 * `vetraLicensing.reportUserStat`. The token, its issue and the Renown relay
 * behind it arrive with the reporting work; this module only names the header.
 */
export const REPORTING_HEADER = "x-vetra-reporting-token";
