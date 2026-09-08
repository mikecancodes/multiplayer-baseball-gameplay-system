import { world, system, ItemStack } from "@minecraft/server";

const CONTACT_BAT_ID = "cc:contact_bat";
const POWER_BAT_ID = "cc:power_bat";

const BALL_TYPES = [
  "cc:baseball_4s_bullet",
  "cc:baseball_changeup_bullet",
  "cc:baseball_curve_bullet",
  "cc:baseball_eephus_bullet",
  "cc:baseball_riser_bullet",
  "cc:baseball_sinker_bullet",
  "cc:baseball_slider_bullet",
  "cc:hitball_bullet"
];

const CONTACT_HIT_RANGE = 5.0;
const POWER_HIT_RANGE = 3.00;
const BATTED_TAG = "cc:batted_ball";
const battedBallIds = new Set();

const CONTACT_HIT_RADIUS = 5.0;
const POWER_HIT_RADIUS = 3.00;

const playerCooldowns = new Map();

const CONTACT_BAT_COOLDOWN = 40;
const POWER_BAT_COOLDOWN = 40;

const HIT_BALL_ID = "cc:hitball_bullet";

const recentlyHit = new Map();

const perfectHitTracker = new Map();

system.run(() => {
  world.sendMessage("Baseball hitting system loaded");
});
function playSoundAtPlayer(player, soundId, pitch = 1.0, volume = 1.0) {
  try {
    player.runCommand(
      `playsound ${soundId} @a[r=50] ~ ~ ~ ${volume} ${pitch}`
    );
  } catch { }
}
function magnitude(v) {
  return Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
}
function triggerBatSwing(player) {
  try {
    player.runCommand("playanimation @s animation.bat.swing");
  } catch { }
}

function normalize(v) {
  const mag = magnitude(v);
  if (mag < 0.0001) return { x: 0, y: 0, z: 0 };
  return { x: v.x / mag, y: v.y / mag, z: v.z / mag };
}

function dot(a, b) {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function isBall(entity) {
  return BALL_TYPES.includes(entity.typeId);
}

function getPitchType(ball) {
  switch (ball.typeId) {
    case "cc:baseball_4s_bullet":
      return "4s";
    case "cc:baseball_changeup_bullet":
      return "changeup";
    case "cc:baseball_curve_bullet":
      return "curve";
    case "cc:baseball_eephus_bullet":
      return "eephus";
    case "cc:baseball_riser_bullet":
      return "riser";
    case "cc:baseball_sinker_bullet":
      return "sinker";
    case "cc:baseball_slider_bullet":
      return "slider";
    case "cc:hitball_bullet":
      return "hitball";
    default:
      return "unknown";
  }
}

function getSwingType(itemId) {
  if (itemId === CONTACT_BAT_ID) return "contact";
  if (itemId === POWER_BAT_ID) return "power";
  return undefined;
}
function spawnSwingParticle(player) {
  try {
    player.runCommand("particle minecraft:basic_crit_particle ^ ^1.2 ^1");
  } catch { }
}


function getSwingSettings(swingType) {
  if (swingType === "contact") {
    return {
      hitRange: CONTACT_HIT_RANGE,
      hitRadius: CONTACT_HIT_RADIUS,
      basePower: 1.7,
      baseLift: 0.22
    };
  }

  return {
    hitRange: POWER_HIT_RANGE,
    hitRadius: POWER_HIT_RADIUS,
    basePower: 2.25,
    baseLift: 2.38
  };
}

function findBallToHit(player, swingType) {
  const settings = getSwingSettings(swingType);
  const eye = player.getHeadLocation();
  const view = normalize(player.getViewDirection());

  const entities = player.dimension.getEntities({
    location: eye,
    maxDistance: settings.hitRange + 1
  });

  let bestBall = undefined;
  let bestScore = -9999;

  for (const entity of entities) {
    if (!isBall(entity)) continue;

    const cooldownUntil = recentlyHit.get(entity.id) ?? 0;
    if (cooldownUntil > system.currentTick) continue;

    const toBall = {
      x: entity.location.x - eye.x,
      y: entity.location.y - eye.y,
      z: entity.location.z - eye.z
    };

    const dist = magnitude(toBall);
    if (dist > settings.hitRange) continue;

    const dirToBall = normalize(toBall);
    const facing = dot(view, dirToBall);

    if (facing < 0.30) continue;

    const projected = {
      x: view.x * dist,
      y: view.y * dist,
      z: view.z * dist
    };

    const offset = {
      x: toBall.x - projected.x,
      y: toBall.y - projected.y,
      z: toBall.z - projected.z
    };

    const missDistance = magnitude(offset);
    if (missDistance > settings.hitRadius) continue;

    const score = facing * 3 - missDistance - dist * 0.12;

    if (score > bestScore) {
      bestScore = score;
      bestBall = entity;
    }
  }

  return bestBall;
}
const TIMING_WINDOWS = {
  contact: {
    sweetSpot: 2.0,

    // Contact bat = more forgiving
    perfect: 0.30,
    little: 0.75,
    normal: 1.25
  },

  power: {
    sweetSpot: 2.0,

    // Power bat = tighter, more skill-based
    perfect: 0.25,
    little: 0.60,
    normal: 0.90
  }
};
function getTimingQuality(player, ball, swingType) {
  const eye = player.getHeadLocation();

  const toBall = {
    x: ball.location.x - eye.x,
    y: ball.location.y - eye.y,
    z: ball.location.z - eye.z
  };

  const dist = magnitude(toBall);

  const windows = TIMING_WINDOWS[swingType] ?? TIMING_WINDOWS.contact;
  const sweetSpot = windows.sweetSpot;

  // Positive = early because ball is still farther away
  // Negative = late because ball is too close/deep
  const error = dist - sweetSpot;
  const absError = Math.abs(error);

  if (absError <= windows.perfect) {
    return {
      label: "Perfect",
      timingQuality: "perfect",
      timingSide: "perfect",
      error
    };
  }

  if (absError <= windows.little) {
    return {
      label: error > 0 ? "Little Early" : "Little Late",
      timingQuality: "good",
      timingSide: error > 0 ? "early" : "late",
      error
    };
  }

  if (absError <= windows.normal) {
    return {
      label: error > 0 ? "Early" : "Late",
      timingQuality: "okay",
      timingSide: error > 0 ? "early" : "late",
      error
    };
  }

  return {
    label: error > 0 ? "Very Early" : "Very Late",
    timingQuality: "bad",
    timingSide: error > 0 ? "early" : "late",
    error
  };
}
function getContactQuality(player, ball, swingType) {
  const settings = getSwingSettings(swingType);
  const eye = player.getHeadLocation();
  const view = normalize(player.getViewDirection());

  const toBall = {
    x: ball.location.x - eye.x,
    y: ball.location.y - eye.y,
    z: ball.location.z - eye.z
  };

  const dist = magnitude(toBall);

  const projected = {
    x: view.x * dist,
    y: view.y * dist,
    z: view.z * dist
  };

  const offset = {
    x: toBall.x - projected.x,
    y: toBall.y - projected.y,
    z: toBall.z - projected.z
  };

  const missDistance = magnitude(offset);
  const ratio = missDistance / settings.hitRadius;

  if (ratio <= 0.22) return "barrel";
  if (ratio <= 0.48) return "solid";
  if (ratio <= 0.78) return "thin";
  return "barely";
}
function getHorizontalDistanceFeet(start, end) {
  const dx = end.x - start.x;
  const dz = end.z - start.z;

  const blocks = Math.sqrt(dx * dx + dz * dz);
  return Math.round(blocks * 6.28084); // 1 block = about 3.28 feet
}

function getHitProfile(
  swingType,
  timingQuality,
  contactQuality,
  timingLabel = "Perfect",
  timingSide = "perfect"
) {
  let power;
  let lift;
  let sprayType = "normal";

  // Convert new timing labels back into old balance tiers
  if (timingLabel === "Perfect") {
    timingQuality = "perfect";
  } else if (timingLabel === "Little Early" || timingLabel === "Little Late") {
    timingQuality = "good";
  } else if (timingLabel === "Early" || timingLabel === "Late") {
    timingQuality = "okay";
  } else if (timingLabel === "Very Early" || timingLabel === "Very Late") {
    timingQuality = "bad";
  }

  // Worst possible contact
  if (timingQuality === "bad" && contactQuality === "barely") {
    return {
      power: swingType === "contact" ? 0.35 : 0.65,
      lift: swingType === "contact" ? 0.45 : 0.70,
      sprayType: "popfly"
    };
  }

  // Base swing values
  if (swingType === "contact") {
    power = 0.80;
    lift = 0.40;
  } else {
    power = 0.65;
    lift = 0.43;
  }

  // Timing quality
  if (timingQuality === "perfect") {
    power += swingType === "contact" ? 0.18 : 0.28;
    lift += swingType === "contact" ? 0.06 : 0.15;
  } else if (timingQuality === "good") {
    power += swingType === "contact" ? 0.13 : 0.22;
    lift += swingType === "contact" ? 0.05 : 0.08;
  } else if (timingQuality === "okay") {
    power += swingType === "contact" ? 0.02 : 0.18;
    lift -= 0.04;
  } else {
    power -= swingType === "contact" ? 0.20 : 0.40;
    lift -= 0.08;
  }

  // Contact quality
  if (contactQuality === "barrel") {
    power += swingType === "contact" ? 0.12 : 0.20;
    lift += swingType === "contact" ? 0.02 : 0.10;
  } else if (contactQuality === "solid") {
    power += swingType === "contact" ? 0.08 : 0.12;
    lift += swingType === "contact" ? 0.00 : 0.04;
  } else if (contactQuality === "thin") {
    power -= 0.10;
    lift += 0.18;
  } else {
    power -= 0.20;
    lift += 0.25;
  }

  // Give sprayType timing identity
  if (timingLabel === "Very Early") sprayType = "very_early";
  else if (timingLabel === "Early") sprayType = "early";
  else if (timingLabel === "Little Early") sprayType = "little_early";
  else if (timingLabel === "Perfect") sprayType = "perfect";
  else if (timingLabel === "Little Late") sprayType = "little_late";
  else if (timingLabel === "Late") sprayType = "late";
  else if (timingLabel === "Very Late") sprayType = "very_late";

  // Perfect + barrel
  if (timingLabel === "Perfect" && contactQuality === "barrel") {
    if (swingType === "power") {
      power += 0.20 + Math.random() * 0.40;
      lift += 0.25 + Math.random() * 0.70;
      sprayType = "perfect_power";
    } else {
      power += 0.60;
      lift = 0.35;
      sprayType = "line_drive";
    }
  }

  // Perfect + solid POWER only
  else if (
    swingType === "power" &&
    timingLabel === "Perfect" &&
    contactQuality === "solid"
  ) {
    const roll = Math.random();

    if (roll < 0.50) {
      power += 0.55;
      lift = 0.20;
      sprayType = "line_drive";
    } else if (roll < 0.53) {
      power += 0.15;
      lift = 0.28;
      sprayType = "big_hit";
    } else {
      power += 0.15;
      lift += 0.08;
      sprayType = "solid_contact";
    }
  }

  // Perfect + solid CONTACT only
  else if (
    swingType === "contact" &&
    timingLabel === "Perfect" &&
    contactQuality === "solid"
  ) {
    power += 0.18;
    lift = 0.14;
    sprayType = "line_drive";
  }

  // Little early/late + barrel
  else if (
    (timingLabel === "Little Early" || timingLabel === "Little Late") &&
    contactQuality === "barrel"
  ) {
    if (swingType === "power") {
      power += 0.07;
      lift += 0.05;
      sprayType = timingSide === "early" ? "pulled_barrel" : "oppo_barrel";
    } else {
      power += 0.08;
      lift = 0.24;
      sprayType = timingSide === "early" ? "pulled_liner" : "oppo_liner";
    }
  }

  // Perfect timing but thin contact = pop fly
  if (timingLabel === "Perfect" && contactQuality === "thin") {
    if (swingType === "power") {
      power *= 0.85;
      lift = 0.55;
      sprayType = "popfly";
    } else {
      power *= 0.65;
      lift = 0.42;
      sprayType = "popfly";
    }
  }

  // Thin or barely contact should not be rewarded
  if (
    (contactQuality === "thin" && timingLabel !== "Perfect") ||
    contactQuality === "barely"
  ) {
    if (swingType === "power") {
      power *= 0.75;
      lift += 0.82;
    } else {
      power *= 0.75;
      lift += 0.10;
    }
  }

  // Very early / very late should be ugly
  if (timingLabel === "Very Early" || timingLabel === "Very Late") {
    power *= swingType === "contact" ? 0.85 : 0.75;

    if (contactQuality === "thin" || contactQuality === "barely") {
      sprayType = "weak_bad_contact";
    }
  }

  // Final caps
  if (swingType === "contact") {
    power = clamp(power, 0.00, 1.55);

    if (
      sprayType === "popfly" ||
      sprayType === "weak_bad_contact"
    ) {
      lift = clamp(lift, 0.35, 0.55);
    } else if (
      sprayType === "line_drive" ||
      sprayType === "pulled_liner" ||
      sprayType === "oppo_liner"
    ) {
      lift = clamp(lift, 0.05, 0.40);
    } else {
      lift = clamp(lift, 0.05, 0.28);
    }
  } else {
    power = clamp(power, 0.00, 2.35);
    lift = clamp(lift, 0.05, 0.64);
  }

  return {
    power,
    lift,
    sprayType
  };
}

function getBatCooldown(itemId) {
  if (itemId === CONTACT_BAT_ID) return CONTACT_BAT_COOLDOWN;
  if (itemId === POWER_BAT_ID) return POWER_BAT_COOLDOWN;
  return 0;
}

function isOnCooldown(playerId) {
  const readyTick = playerCooldowns.get(playerId) ?? 0;
  return system.currentTick < readyTick;
}

function setCooldown(playerId, itemId) {
  const cooldown = getBatCooldown(itemId);
  playerCooldowns.set(playerId, system.currentTick + cooldown);
}
function isPerfectPerfect(timingQuality, contactQuality) {
  return timingQuality === "perfect" && contactQuality === "barrel";
}
function getRightVector(view) {
  return {
    x: -view.z,
    y: 0,
    z: view.x
  };
}
function hitBall(player, ball, swingType) {
  const pitchType = getPitchType(ball);

  const timing = getTimingQuality(player, ball, swingType);
  const timingQuality = timing.timingQuality;

  const contactQuality = getContactQuality(player, ball, swingType);

  const profile = getHitProfile(
    swingType,
    timingQuality,
    contactQuality,
    timing.label,
    timing.timingSide
  );

  const view = normalize(player.getViewDirection());
  const incoming = ball.getVelocity();
  const dim = ball.dimension;

  if (isPerfectPerfect(timingQuality, contactQuality)) {
    player.runCommand('playsound cc:perfect_perfect @a');
  } else {
    player.runCommand('playsound cc:bat_hit @a');
  }

  const hitLoc = {
    x: ball.location.x,
    y: ball.location.y,
    z: ball.location.z
  };

  const carry = {
    x: incoming.x * 0.10,
    y: Math.max(-0.05, incoming.y * 0.05),
    z: incoming.z * 0.10
  };

  const right = getRightVector(view);

  let spray = 0;
  if (timingQuality === "perfect") {
    spray = (Math.random() - 0.5) * 1.45;
  } else if (timingQuality === "good") {
    spray = (Math.random() - 0.5) * 1.75;
  } else if (timingQuality === "okay") {
    if (Math.random() < 0.4) {
      const side = Math.random() < 0.5 ? -1.0 : 1.0;
      spray = side * (1.05 + Math.random() * 0.2);
    } else {
      spray = (Math.random() - 0.5) * 1.95;
    }
  } else {
    spray = Math.random() < 0.5 ? -1.4 : 1.4;
  }

  const finalDir = normalize({
    x: view.x + right.x * spray,
    y: view.y,
    z: view.z + right.z * spray
  });

  let oldBallId;
  try {
    oldBallId = ball.id;
  } catch {
    player.onScreenDisplay.setActionBar("Hit failed");
    return;
  }

  let newBall;
  try {
    ball.remove();

    newBall = dim.spawnEntity(HIT_BALL_ID, hitLoc);

    newBall.applyImpulse({
      x: finalDir.x * profile.power + carry.x,
      y: profile.lift + carry.y,
      z: finalDir.z * profile.power + carry.z
    });
  } catch (e) {
    world.sendMessage(`Hit failed: ${e}`);
    return;
  }

  if (isPerfectPerfect(timingQuality, contactQuality)) {
    perfectHitTracker.set(newBall.id, {
      playerName: player.name,
      startLocation: hitLoc,
      swingType,
      pitchType
    });

    playSoundAtPlayer(player, "cc:perfect_perfect", 1.0, 0.9);
  } else {
    playSoundAtPlayer(player, "cc:bat_hit", 1.0, 0.6);
  }

  battedBallIds.delete(oldBallId);

  try {
    battedBallIds.add(newBall.id);
    recentlyHit.set(newBall.id, system.currentTick + 8);
  } catch { }

  player.onScreenDisplay.setActionBar(
    `${swingType} | ${pitchType} | ${timing.label} | ${contactQuality}`
  );
}
world.afterEvents.projectileHitBlock.subscribe((event) => {
  const projectile = event.projectile;
  if (!projectile) return;

  let projectileId;
  let projectileType;

  try {
    projectileId = projectile.id;
    projectileType = projectile.typeId;
  } catch {
    return;
  }

  // If a thrown snowball hits the ground, drop a snowball item
  if (projectileType === "minecraft:snowball") {
    const spawnLoc = {
      x: event.location.x,
      y: event.location.y + 0.15,
      z: event.location.z
    };

    try {
      event.dimension.spawnItem(new ItemStack("minecraft:snowball", 1), spawnLoc);
    } catch { }

    try {
      projectile.remove();
    } catch { }

    return;
  }

  if (!BALL_TYPES.includes(projectileType)) return;
  if (!battedBallIds.has(projectileId)) return;

  const perfectData = perfectHitTracker.get(projectileId);

  if (perfectData) {
    const feet = getHorizontalDistanceFeet(
      perfectData.startLocation,
      event.location
    );

    world.sendMessage(
      `§6PERFECT BARREL! §f${perfectData.playerName} hit it §e${feet} ft§f!`
    );

    perfectHitTracker.delete(projectileId);
  }

  const spawnLoc = {
    x: event.location.x,
    y: event.location.y + 0.15,
    z: event.location.z
  };

  try {
    event.dimension.spawnItem(new ItemStack("minecraft:snowball", 1), spawnLoc);
  } catch { }

  battedBallIds.delete(projectileId);

  try {
    projectile.remove();
  } catch { }
});
world.afterEvents.projectileHitEntity.subscribe((event) => {
  const projectile = event.projectile;
  if (!projectile) return;

  let projectileId;
  let projectileType;
  let hitEntity;

  try {
    projectileId = projectile.id;
    projectileType = projectile.typeId;
    hitEntity = event.getEntityHit().entity;
  } catch {
    return;
  }

  if (!hitEntity) return;

  // Snowball thrown out message
  if (projectileType === "minecraft:snowball" && hitEntity.typeId === "minecraft:player") {
    const playerOutName = hitEntity.nameTag || hitEntity.name || "Unknown Player";
    const throwerName = event.source?.nameTag || event.source?.name || "Unknown Player";

    world.sendMessage(`§cPlayer §e"${playerOutName}" §cthrown out by §e"${throwerName}"`);

    try {
      projectile.remove();
    } catch { }

    return;
  }

  // Hitball caught out logic
  if (projectileType !== "cc:hitball_bullet") return;
  if (!battedBallIds.has(projectileId)) return;

  const catcherName = hitEntity.nameTag || hitEntity.name || "Unknown Player";

  world.sendMessage(`§cOUT! §fCaught by §e${catcherName}`);

  try {
    hitEntity.applyDamage(4);
  } catch { }

  const perfectData = perfectHitTracker.get(projectileId);

  if (perfectData) {
    perfectHitTracker.delete(projectileId);
  }

  battedBallIds.delete(projectileId);

  try {
    projectile.remove();
  } catch { }
});
world.afterEvents.itemUse.subscribe((event) => {
  const player = event.source;
  const item = event.itemStack;

  if (!item) return;

  const swingType = getSwingType(item.typeId);
  if (!swingType) return;

  const playerId = player.id;

  // 🚫 cooldown check
  if (isOnCooldown(playerId)) {
    player.onScreenDisplay.setActionBar("Cooldown");
    playSoundAtPlayer(player, "note.bass");
    return;
  }

  // ✅ apply cooldown
  setCooldown(playerId, item.typeId);

  // 🔊 swing sound
  player.runCommand('playsound cc:bat_swing @a');
  triggerBatSwing(player);
  spawnSwingParticle(player);
  const ball = findBallToHit(player, swingType);

  if (!ball) {
    player.onScreenDisplay.setActionBar("Miss");
    return;
  }

  hitBall(player, ball, swingType);
});
const snowballCounts = new Map();

function getSnowballCount(player) {
  const inventory = player.getComponent("minecraft:inventory");
  if (!inventory) return 0;

  const container = inventory.container;
  let count = 0;

  for (let i = 0; i < container.size; i++) {
    const item = container.getItem(i);

    if (item && item.typeId === "minecraft:snowball") {
      count += item.amount;
    }
  }

  return count;
}

system.runInterval(() => {
  for (const player of world.getPlayers()) {
    const playerId = player.id;
    const currentCount = getSnowballCount(player);
    const previousCount = snowballCounts.get(playerId) ?? currentCount;

    if (currentCount > previousCount) {
      const pickedUpAmount = currentCount - previousCount;
      const playerName = player.nameTag || player.name || "Unknown Player";

      world.sendMessage(`§b${playerName} §fpicked up ball`);
    }

    snowballCounts.set(playerId, currentCount);
  }
}, 5);
system.runInterval(() => {
  const dim = world.getDimension("overworld");

  const sliders = dim.getEntities({
    type: "cc:baseball_slider_bullet"
  });

  for (const ball of sliders) {
    try {
      ball.applyImpulse({
        x: 0.025,
        y: -0.015,
        z: 0
      });
    } catch { }
  }
  const hitballs = dim.getEntities({
    type: "cc:hitball_bullet"
  });
}, 1)