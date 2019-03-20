import React from 'react'
import ACTIONS from 'data/ACTIONS'
import CooldownDowntime from 'parser/core/modules/CooldownDowntime'
import {Trans} from '@lingui/react'

const TARGETPERCENT = 95
const FIRSTUSEOFFSETALL = 15000
const FIRSTUSEOFFSETCONV = 25000

export default class OGCDDowntime extends CooldownDowntime {
	//Time in ms that Laqi deems ok for a OGCD to be down : ^)
	allowedDowntime = 0
	firstUseOffset = FIRSTUSEOFFSETALL
	firstUseffsetPerOgcd = {
		[ACTIONS.CONVERT.id]: FIRSTUSEOFFSETCONV,
	}
	trackedCds = [
		ACTIONS.LEY_LINES.id,
		ACTIONS.SHARPCAST.id,
		ACTIONS.TRIPLECAST.id,
		ACTIONS.CONVERT.id,
	]
	target = TARGETPERCENT
	description = <Trans id="blm.ogcd-downtime.ogcd-cd-metric">Always make sure to use your OGCDs when they are up but don't clip them. Utilize your procs or fast Blizzard IIIs or Fire IIIs to weave them. {this.allowedDowntime === 0 ? '' : <Trans id="blm.ogcd-downtime.ogcd-cd-buffer">To account for random factors you are given a buffer of {this.parser.formatDuration(this.allowedDowntime)} seconds per instance to hold your cooldowns.</Trans>}</Trans>

}
