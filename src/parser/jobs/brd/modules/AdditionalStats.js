/**
 * @author Yumiya
 */
import Module from 'parser/core/Module'
import ACTIONS, {getAction} from 'data/ACTIONS'
import STATUSES from 'data/STATUSES'
import math from 'mathjsCustom'

// Relevant crit buffs
const CRIT_MODIFIERS = [
	{
		id: STATUSES.BATTLE_LITANY.id,
		strength: 0.15,
	},
	{
		id: STATUSES.CHAIN_STRATAGEM.id,
		strength: 0.15,
	},
	{
		id: STATUSES.CRITICAL_UP.id,
		strength: 0.02,
	},
	{
		id: STATUSES.THE_SPEAR.id,
		//fuck royal road
		strength: 0.10,
	},
	{
		id: STATUSES.STRAIGHT_SHOT.id,
		strength: 0.10,
	},
]

// Skills that snapshot dots and their respective dot statuses (let's do it BRD only for now)
// TODO: Populate with other jobs DoTs and Snapshotters
const SNAPSHOTTERS = {
	[ACTIONS.IRON_JAWS.id]: [
		STATUSES.CAUSTIC_BITE.id,
		STATUSES.STORMBITE.id,
	],
	[ACTIONS.CAUSTIC_BITE.id]: [
		STATUSES.CAUSTIC_BITE.id,
	],
	[ACTIONS.STORMBITE.id]: [
		STATUSES.STORMBITE.id,
	],
}

// Relevant dot statuses (let's do it BRD only for now)
const DOTS = [
	STATUSES.CAUSTIC_BITE.id,
	STATUSES.STORMBITE.id,
]

const DHIT_MOD = 1.25

const DISEMBOWEL_STRENGTH = 0.05
const TRAIT_STRENGTH = 0.20

const DEVIATION_PRECISION = 3

const BASE_SUBSTAT_70 = 364
const LEVEL_MOD_70 = 2170

export default class AdditionalStats extends Module {
	static handle = 'additionalStats'
	static dependencies = [
		'additionalEvents', // eslint-disable-line xivanalysis/no-unused-dependencies
		'combatants',
		// Relying on the normaliser from this for the hit type fields
		'hitType', // eslint-disable-line xivanalysis/no-unused-dependencies
	]

	// Represents a map of IDs and statuses for each enemy in this parse
	_enemies = {}

	// Represents the player statuses
	_player = {
		statuses: {},
	}

	// Represents a map of IDs and statuses for each snapshotter skill in this parse
	_snapshotters = {}

	// Let's store these in the class like normal people
	_damageInstances = {}
	_critFromDots = []

	// Additional info to be calculated
	criticalHitProbability
	criticalHitRate
	critMod
	k

	normalise(events) {

		for (const event of events) {

			// Registers buffs/debuffs statuses on the respective entity (either player or enemies)
			if (event.type.match(/^(apply|remove|refresh)(de)?buff(stack)?$/)) {
				// In case it's a status on the selected player
				if (event.targetID === this.combatants.selected.id && event.ability) {
					this._player.statuses[event.ability.guid] = event.type.startsWith('apply') || event.type.startsWith('refresh')

				// In case it's a status on an enemy, we attribute it to that specific enemy by the ID
				} else if (!event.targetIsFriendly) {
					const enemy = this._getEnemy(event.targetID)
					enemy.statuses[event.ability.guid] = event.type.startsWith('apply') || event.type.startsWith('refresh')

					// Separately checks for dot application, too
					if (
						DOTS.includes(event.ability.guid)
						&& (event.type.startsWith('apply') || event.type.startsWith('refresh'))
					) {
						// We fetch only the snapshotters that affect the current dot
						const snapshotters = Object.keys(SNAPSHOTTERS)
							.filter(action => SNAPSHOTTERS[action].includes(event.ability.guid))
							.map(action => this._getSnapshotter(action))

						// We snapshot statuses from the most recent snapshotter that affects this dot
						const snapshotter = snapshotters.reduce((a, b) => { return a.timestamp > b.timestamp ? a : b })

						// We get the dot component from the enemy
						const dot = this._getDot(enemy, event.ability.guid)

						this._snapshotStatuses(dot, snapshotter)
					}

				}

			// For every damage event that:
			// - comes from the player
			// - has an ability attached to it
			} else if (
				event.type === 'damage'
				&& event.sourceID === this.combatants.selected.id
				&& event.ability
			) {
				// If it's not a dot tick
				if (!event.tick) {
					// Fixing the multiplier
					// TODO: Skills should probably have a property with their type/element and category, otherwise this will only work on BRD
					let fixedMultiplier = event.debugMultiplier
					if ( // Spells (songs)
						event.ability.guid !== ACTIONS.THE_WANDERERS_MINUET.id
						&& event.ability.guid !== ACTIONS.MAGES_BALLAD.id
						&& event.ability.guid !== ACTIONS.ARMYS_PAEON.id
					) {
						// Band-aid fix for disembowel (why, oh, why)
						if (this._hasStatus(this._getEnemy(event.targetID), STATUSES.PIERCING_RESISTANCE_DOWN.id)) {
							fixedMultiplier = Math.trunc((fixedMultiplier + DISEMBOWEL_STRENGTH) * 100) / 100
						}
						// AND ALSO FOR RANGED TRAIT, BECAUSE APPARENTLY IT'S PHYSICAL DAMAGE ONLY REEEEEEEEEE
						fixedMultiplier = Math.trunc((fixedMultiplier + TRAIT_STRENGTH) * 100) / 100
					}

					// Collects the damage instances, to be used for calculating crit and 'K'
					// TODO: Have a filtered array with skills

					// ...let's not count Spears for now
					if (!this._hasStatus(this._player, STATUSES.THE_SPEAR.id)) {

						const critTier = this._parseCritBuffs(event)

						// We store the damage event, grouping them by Δcrit tiers
						if (!this._damageInstances[critTier]) {
							this._damageInstances[critTier] = []
						}

						this._damageInstances[critTier].push({event: event, rawDamage: event.amount / fixedMultiplier})
					}

				// If it's a dot tick (yay, they have/used a dot!), we will collect the data to get a better critMod approximation
				} else {
					const enemy = this._getEnemy(event.targetID)
					const dot = this._getDot(enemy, event.ability.guid)

					// Not comfortable with counting Spears just yet
					if (!this._hasStatus(dot, STATUSES.THE_SPEAR.id)) {

						const accumulatedCritBuffs = this._parseDotCritBuffs(event)
						const critRate = event.expectedCritRate / 1000 - accumulatedCritBuffs

						this._critFromDots.push(critRate)

					}
				}
			// We also register the last snapshotter cast, to... snapshot the statuses on the dots
			} else if (
				event.type === 'cast'
				&& event.sourceID === this.combatants.selected.id
				&& event.ability
				&& Object.keys(SNAPSHOTTERS).includes(event.ability.guid.toString()) // Why do I have to use toString() here? This is dumb
			) {
				const snapshotter = this._getSnapshotter(event.ability.guid)
				const player = this._player
				const enemy = this._getEnemy(event.targetID)

				this._snapshotStatuses(snapshotter, player, enemy)
				snapshotter.timestamp = event.timestamp
			}
		}

		// We calculate this info
		this.criticalHitProbability = this._getCriticalHitProbability()
		this.criticalHitRate = this._getCriticalHitRate()
		this.critMod = this._getCritMod()
		this.k = this._getK()

		// Return all this shit
		return events
	}

	// Returns the enemy statuses state and dots state given the ID
	_getEnemy(targetId) {
		if (!this._enemies[targetId]) {
			this._enemies[targetId] = {
				statuses: {},
				dots: {},
			}
		}

		return this._enemies[targetId]
	}

	// Returns the dot state from an enemy given the status ID
	_getDot(enemy, statusId) {

		if (!enemy.dots[statusId]) {
			enemy.dots[statusId] = {
				statuses: {},
			}
		}

		return enemy.dots[statusId]
	}

	// Returns the latest snapshotter state
	_getSnapshotter(skillId) {
		if (!this._snapshotters[skillId]) {
			this._snapshotters[skillId] = {
				statuses: {},
				timestamp: 0,
			}
		}

		return this._snapshotters[skillId]
	}

	_hasStatus(entity, status) {
		return entity.statuses[status] || false
	}

	// Copies all the statuses from multiple sources to a target entity
	_snapshotStatuses(target, ...sources) {

		sources.forEach(source => {
			Object.keys(source.statuses).forEach(status => {
				target.statuses[status] = source.statuses[status]

			})
		})
	}

	// Returns the accumulated crit modifier from all the currently active crit buffs/debuffs
	_parseCritBuffs(event) {
		// We need to get the specific enemy in case it's Chain Stratagem
		const enemy = this._getEnemy(event.targetID)
		const player = this._player

		let accumulatedCritBuffs = 0

		for (const modifier of CRIT_MODIFIERS) {

			let hasStatus = false

			if (modifier.id === STATUSES.CHAIN_STRATAGEM.id) {
				hasStatus = this._hasStatus(enemy, modifier.id)
			} else {
				hasStatus = this._hasStatus(player, modifier.id)
			}
			if (hasStatus) {
				accumulatedCritBuffs += modifier.strength
			}

		}

		return accumulatedCritBuffs
	}

	// Same as above, but dots statuses are snapshotted, so they're stored separately
	_parseDotCritBuffs(event) {
		// We need the enemy to which the dot was applied
		const enemy = this._getEnemy(event.targetID)
		const dot = this._getDot(enemy, event.ability.guid)

		let accumulatedCritBuffs = 0

		for (const modifier of CRIT_MODIFIERS) {

			const hasStatus = this._hasStatus(dot, modifier.id)
			if (hasStatus) {
				accumulatedCritBuffs += modifier.strength
			}

		}

		return accumulatedCritBuffs
	}

	// Sorry, but these constants are all fucking magic
	/* eslint-disable no-magic-numbers */

	// Reference to the formulas: https://docs.google.com/document/d/1h85J3xPhVZ2ubqR77gzoD16L4T-Pltv3dnsKthE4k60/edit
	// Credits to The TheoryJerks
	_getCriticalHitProbability() {

		// If we have crit rate information from dots, we use that instead
		if (this._critFromDots.length) {
			return this._getEmpiricalRuleSubsetMean(this._critFromDots, DEVIATION_PRECISION)

		}
		// Otherwise, some mathmagic takes place to approximate the crit rate

		const rates = []
		for (const critTier of Object.keys(this._damageInstances)) {
			const sampleSize = this._damageInstances[critTier].length
			const critAmount= this._damageInstances[critTier].filter(x => x.event.criticalHit).length
			const rate = Math.max((critAmount/sampleSize) - Number.parseFloat(critTier), 0)

			rates.push({rate: rate, amount: sampleSize})
		}
		const weightedRates = rates.reduce((acc, value) => acc + value.rate * value.amount, 0)
		const totalAmount = rates.reduce((acc, value) => acc + value.amount, 0)

		return weightedRates/totalAmount

	}

	_getCriticalHitRate() {
		const critRate = this.criticalHitProbability || this._getCriticalHitProbability()

		// Time to guesstimate the critical hit rate attribute
		return (((critRate * 1000) - 50) * LEVEL_MOD_70 / 200) + BASE_SUBSTAT_70
	}

	_getCritMod() {
		const chr = this.criticalHitRate || this._getCriticalHitRate()

		// Time to guesstimate the critMod:
		return Math.floor((200 * (chr - BASE_SUBSTAT_70) / LEVEL_MOD_70) + 1400) / 1000

	}
	/* eslint-enable no-magic-numbers */

	// We use the damage events to determine 'K'
	// tl;dr: 'K' is an approximation to damage to potency ratio, ignoring the natural 5% spread because we don't need this kind of precision
	_getK() {
		const values = []
		const critMod = this.critMod || this._getCritMod()

		// We iterate over all damage events, across all crit buff tiers
		for (const critTier of Object.keys(this._damageInstances)) {
			for (const instance of this._damageInstances[critTier]) {

				// Let's not count auto attacks, because they have a different formula and aren't affected by the 20% trait
				if (instance.event.ability.guid === ACTIONS.SHOT.id) {
					continue
				}

				const skill = getAction(instance.event.ability.guid)

				// We have already calculated the unbuffed damage, now we need to strip crit/dhit modifiers
				let rawDamage = instance.rawDamage

				if (instance.event.criticalHit) {
					rawDamage = Math.trunc(rawDamage / critMod)
				}

				if (instance.event.directHit) {
					rawDamage = Math.trunc(rawDamage / DHIT_MOD)
				}

				// If we have the potency information for the current skill and it's not a conditional potency skill, we add it's potency ratio to the array of potential 'K' values
				if (skill.potency && !isNaN(skill.potency)) {
					values.push(Math.round(rawDamage * 100 / skill.potency))
				}
			}
		}

		return this._getEmpiricalRuleSubsetMean(values, DEVIATION_PRECISION)

	}

	// This method returns the mean of the data subset within {n} standard deviations of the mean of the data set
	_getEmpiricalRuleSubsetMean(dataset, n) {
		const mean = math.mean(dataset)
		const standardDeviation = math.std(dataset)

		return math.mean(dataset.filter(v => v > mean - n * standardDeviation && v < mean + n * standardDeviation))
	}

}