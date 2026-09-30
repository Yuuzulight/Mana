// #1168: ad and tracker domains her browser never loads. Under site
// isolation every cross-site ad iframe costs a renderer process, so these
// are most of an ad-heavy page's RAM. A domain blocks its subdomains too.
// ponytail: a short hand-kept list of the big networks, not a full filter
// list; add a domain here when a page she uses still pulls in a lot.
const AD_HOSTS = new Set([
  // Google ads and analytics
  "doubleclick.net", "googlesyndication.com", "googleadservices.com", "googletagservices.com",
  "google-analytics.com", "googletagmanager.com", "adservice.google.com", "imasdk.googleapis.com",
  // ad exchanges and networks
  "amazon-adsystem.com", "adnxs.com", "criteo.com", "criteo.net", "pubmatic.com", "rubiconproject.com",
  "openx.net", "casalemedia.com", "indexww.com", "adsrvr.org", "bidswitch.net", "3lift.com",
  "sharethrough.com", "smartadserver.com", "teads.tv", "yieldmo.com", "media.net", "sonobi.com",
  "taboola.com", "outbrain.com", "zemanta.com", "adform.net", "advertising.com",
  "moatads.com", "doubleverify.com", "adsafeprotected.com", "serving-sys.com", "flashtalking.com",
  "permutive.com", "permutive.app", "id5-sync.com", "liadm.com", "rlcdn.com", "crwdcntrl.net",
  // trackers
  "scorecardresearch.com", "quantserve.com", "chartbeat.com", "chartbeat.net", "hotjar.com",
  "krxd.net", "demdex.net", "omtrdc.net", "everesttech.net", "bounceexchange.com", "nr-data.net",
  "segment.io", "mixpanel.com", "connect.facebook.net", "bat.bing.com", "clarity.ms", "ads.linkedin.com",
  "analytics.tiktok.com", "ads-twitter.com", "static.ads-twitter.com",
]);

function isAdHost(hostname) {
  const parts = String(hostname || "").toLowerCase().split(".");
  for (let i = 0; i < parts.length - 1; i += 1) {
    if (AD_HOSTS.has(parts.slice(i).join("."))) return true;
  }
  return false;
}

module.exports = { AD_HOSTS, isAdHost };
