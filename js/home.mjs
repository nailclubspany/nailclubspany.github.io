// Homepage: counts taps on the phone links (see js/funnel.mjs), so calls show
// up next to the booking page's step counters.
import { isTestHost } from './booking-support.mjs';
import { pageCounter, trackCalls } from './funnel.mjs';

trackCalls(pageCounter(isTestHost(location.hostname)));
