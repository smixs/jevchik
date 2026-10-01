// Vectors computed independently with Python hmac/hashlib (not with the code under test). Do not regenerate with src/web/auth.ts.
export const BOT_TOKEN = '123456:TEST-TOKEN-abcdef'
export const OTHER_BOT_TOKEN = '999999:OTHER-BOT-token'
export const AUTH_T0 = 1788264000
export const VECTORS = {
  bob_lb: "auth_date=1788264000&query_id=AAH1&user=%7B%22id%22%3A2%2C%22first_name%22%3A%22Bob%22%2C%22username%22%3A%22bob%22%7D&start_param=lb_-1001234567890&hash=d7eb463d73c642f36a3fac2a694b1d88c3e58646a810259cfdab27305c0fc5b1",
  admin_admin: "auth_date=1788264000&query_id=AAH2&user=%7B%22id%22%3A99%2C%22first_name%22%3A%22Admin%22%7D&start_param=admin_-1001234567890&hash=2748a5432076917f7c673270f5885ae57044d988226b2c45d3e40ae281b63ec1",
  alice_me_other: "auth_date=1788264000&query_id=AAH3&user=%7B%22id%22%3A1%2C%22first_name%22%3A%22Alice%22%2C%22username%22%3A%22alice%22%7D&start_param=me_-1009876543210&hash=dbe23bcd7416a33f6a193a22ddb46091df82e874108b9f7547d1351b1be8bc79",
  old: "auth_date=1788177599&query_id=AAH4&user=%7B%22id%22%3A2%2C%22first_name%22%3A%22Bob%22%2C%22username%22%3A%22bob%22%7D&start_param=lb_-1001234567890&hash=1e451a12f601b62312feadc65e604130be21a435980399cdcf2c428fd802b77c",
  edge: "auth_date=1788177600&query_id=AAH5&user=%7B%22id%22%3A2%2C%22first_name%22%3A%22Bob%22%2C%22username%22%3A%22bob%22%7D&start_param=lb_-1001234567890&hash=15e6758276f9df762e22e66d6455556112c6ea0adb3ee9eb2f7bc4d07b624f51",
  other_bot: "auth_date=1788264000&query_id=AAH1&user=%7B%22id%22%3A2%2C%22first_name%22%3A%22Bob%22%2C%22username%22%3A%22bob%22%7D&start_param=lb_-1001234567890&hash=52e8fb1bd8f7ad396ae401c3b41f25ff7c5356fb56020431f8abcca492a66923",
  cyr: "auth_date=1788264000&query_id=AAH6&user=%7B%22id%22%3A3%2C%22first_name%22%3A%22%D0%9A%D0%B0%D1%80%D0%BE%D0%BB%20%D0%81%D0%BB%D0%BA%D0%B8%D0%BD%D0%B0%22%7D&start_param=lb_-1001234567890&hash=c7d408989898ec87a5d880acda3dd3bb7447b3c4d6e83ceea5ff3cd840844c42",
  no_ctx: "auth_date=1788264000&query_id=AAH7&user=%7B%22id%22%3A2%2C%22first_name%22%3A%22Bob%22%2C%22username%22%3A%22bob%22%7D&hash=68604cd7ecdbd361ca8e29ce65cdf1d963afdaefacc027ea398b5eadb08d66e4",
  alice_appeal: "auth_date=1788264000&query_id=AAH8&user=%7B%22id%22%3A1%2C%22first_name%22%3A%22Alice%22%2C%22username%22%3A%22alice%22%7D&start_param=appeal_-1001234567890&hash=e08a97b50796e3d6e69b5168a0d31359a2e5ee6a7fbd8034c01b98541edcc8dd",
  carol_appeal: "auth_date=1788264000&query_id=AAH9&user=%7B%22id%22%3A3%2C%22first_name%22%3A%22Carol%22%7D&start_param=appeal_-1001234567890&hash=63bb00b3867214fc0b14aa9b950c4362f4b1ec92a8770a2bb973dc975135c3ac",
  alice_me: "auth_date=1788264000&query_id=AAH10&user=%7B%22id%22%3A1%2C%22first_name%22%3A%22Alice%22%2C%22username%22%3A%22alice%22%7D&start_param=me_-1001234567890&hash=050a2c230cc98ad85bb8ccaef7b6655a6fb9d94c29a75ce11fbfce9303bcdea8",
  alice_lb: "auth_date=1788264000&query_id=AAH11&user=%7B%22id%22%3A1%2C%22first_name%22%3A%22Alice%22%2C%22username%22%3A%22alice%22%7D&start_param=lb_-1001234567890&hash=8666725d43dae62dcd2425885b0dfdc8e08b528b4ebb1de1f918cd3be8180d98",
  bob_admin: "auth_date=1788264000&query_id=AAH12&user=%7B%22id%22%3A2%2C%22first_name%22%3A%22Bob%22%2C%22username%22%3A%22bob%22%7D&start_param=admin_-1001234567890&hash=b9d6e984734b0234721902a36448a32d8eb062428757c001603f5016e07b6c1d",
  outsider_lb: "auth_date=1788264000&query_id=AAH13&user=%7B%22id%22%3A555%2C%22first_name%22%3A%22Outsider%22%7D&start_param=lb_-1001234567890&hash=411b15eee145f08adc124658111e517d625bbaa9a49cc7399415884f705b9db1",
  outsider_other: "auth_date=1788264000&query_id=AAH14&user=%7B%22id%22%3A555%2C%22first_name%22%3A%22Outsider%22%7D&start_param=lb_-1009876543210&hash=97ac1004ede450b23e35d229556b680359373fa71a61b8434bbad4a1a86d2084",
  outsider_unknown: "auth_date=1788264000&query_id=AAH15&user=%7B%22id%22%3A555%2C%22first_name%22%3A%22Outsider%22%7D&start_param=lb_-1005555555555&hash=32e2d110c21f147f69b59cb10318079c4202c6bf9bba05eb827e58ffad63a71a",
  alice_no_ctx: "auth_date=1788264000&query_id=AAH16&user=%7B%22id%22%3A1%2C%22first_name%22%3A%22Alice%22%2C%22username%22%3A%22alice%22%7D&hash=3ba23131cd2972050103e61ec50227912fed111831220d3cb20d586d38efbd2a",
  admin_no_ctx: "auth_date=1788264000&query_id=AAH17&user=%7B%22id%22%3A99%2C%22first_name%22%3A%22Admin%22%7D&hash=fcd600b98ec37c316a00d33dcca05e72e733eaecad7565a9db9ea9a6597684a7",
  outsider_no_ctx: "auth_date=1788264000&query_id=AAH18&user=%7B%22id%22%3A555%2C%22first_name%22%3A%22Outsider%22%7D&hash=7b2bb6a7c8babba8dfaac9e4b5c34310d360a9a4b7f1f637f86250bb4f24da64",
  bob_unknown_ctx: "auth_date=1788264000&query_id=AAH19&user=%7B%22id%22%3A2%2C%22first_name%22%3A%22Bob%22%2C%22username%22%3A%22bob%22%7D&start_param=lb_-1005555555555&hash=d416b6d3ddca8222fb1cb8fed77af762450db503df01e8c034c7bd40bfab3d2d",
  bob_bad_ctx: "auth_date=1788264000&query_id=AAH20&user=%7B%22id%22%3A2%2C%22first_name%22%3A%22Bob%22%2C%22username%22%3A%22bob%22%7D&start_param=garbage&hash=e8b81a72db353c5c7f20bced132da03ed15312579a1efa9b0412e2b6def02661",
} as const
