using UnityEngine;

namespace SkillApp.ChickenRun.View
{
    /// <summary>
    /// Composite props, built out of the shared cube and sphere.
    ///
    /// ── Why build models out of primitives at all ────────────────────────────
    ///
    /// There are no art assets in this project and there is no licence to ship
    /// any I did not make. So the choice is between a world of single tinted
    /// boxes and a world of small assemblies of tinted boxes, and the difference
    /// between those two is most of what "looks finished" means at this scale.
    ///
    /// A car that is one red rectangle reads as a placeholder. The same car with
    /// a darker cabin, two black wheels and a windscreen reads as a car — it is
    /// four extra cubes and no new dependency. That trade is available for almost
    /// everything on screen, and this file is where it is taken.
    ///
    /// ── The rule these follow ────────────────────────────────────────────────
    ///
    /// Every prop is built INSIDE a unit-sized parent, so the caller can scale
    /// and position the parent exactly as it did the old single cube and the
    /// parts follow. Nothing here knows about the simulation; a prop is given a
    /// size and a colour and returns a Transform.
    /// </summary>
    public static class Props
    {
        /// <summary>Attach a tinted cube as a child, sized and placed in parent space.</summary>
        public static GameObject Part(
            Transform parent, Material material, string name,
            Vector3 size, Vector3 position, Color color)
        {
            var go = PrimitiveMesh.CubeObject(name, material);
            go.transform.SetParent(parent, false);
            go.transform.localScale = size;
            go.transform.localPosition = position;
            Tint(go, color);
            return go;
        }

        /// <summary>Attach a tinted sphere as a child.</summary>
        public static GameObject Ball(
            Transform parent, Material material, string name,
            float diameter, Vector3 position, Color color)
        {
            var go = PrimitiveMesh.SphereObject(name, material);
            go.transform.SetParent(parent, false);
            go.transform.localScale = Vector3.one * diameter;
            go.transform.localPosition = position;
            Tint(go, color);
            return go;
        }

        public static void Tint(GameObject go, Color color)
        {
            var r = go.GetComponent<MeshRenderer>();
            if (r == null) return;
            var block = new MaterialPropertyBlock();
            r.GetPropertyBlock(block);
            // URP Lit uses _BaseColor; Standard and the old Unlit use _Color.
            block.SetColor("_BaseColor", color);
            block.SetColor("_Color", color);
            r.SetPropertyBlock(block);
        }

        /// <summary>Darken a colour, for the shaded underside of a prop.</summary>
        public static Color Shade(Color c, float amount) =>
            Color.Lerp(c, Color.black, amount);

        /// <summary>Lighten a colour, for a highlight or a painted marking.</summary>
        public static Color Lift(Color c, float amount) =>
            Color.Lerp(c, Color.white, amount);

        // ── Chicken Run ─────────────────────────────────────────────────────

        /// <summary>
        /// A car or truck, built to fill a lane body of `cells` length.
        ///
        /// The parts are placed in a 1x1x1 parent so the caller scales the parent
        /// to the lane body's real size, exactly as it did the single cube this
        /// replaces. Wheels sit slightly proud of the sides so they read at the
        /// shallow angle the camera looks from.
        /// </summary>
        public static void BuildVehicle(Transform parent, Material material, Color body)
        {
            Color dark = Shade(body, 0.35f);
            Color glass = new Color(0.30f, 0.42f, 0.52f);
            Color tyre = new Color(0.12f, 0.12f, 0.14f);
            Color lamp = new Color(1f, 0.94f, 0.72f);

            // Chassis. Slightly less than full height so the cabin reads on top.
            Part(parent, material, "Body", new Vector3(1f, 0.62f, 1f),
                new Vector3(0f, -0.19f, 0f), body);

            // Cabin, inset and shorter, sitting on the chassis.
            Part(parent, material, "Cabin", new Vector3(0.54f, 0.42f, 0.86f),
                new Vector3(-0.04f, 0.21f, 0f), Lift(body, 0.12f));

            // Windscreen, a dark band across the cabin front.
            Part(parent, material, "Glass", new Vector3(0.10f, 0.26f, 0.80f),
                new Vector3(0.22f, 0.23f, 0f), glass);

            // Wheels, proud of both flanks.
            foreach (float x in new[] { -0.30f, 0.30f })
            {
                foreach (float z in new[] { -0.52f, 0.52f })
                {
                    Part(parent, material, "Wheel", new Vector3(0.22f, 0.30f, 0.10f),
                        new Vector3(x, -0.44f, z), tyre);
                }
            }

            // One headlamp at the nose, so a car has a front and a back and the
            // eye can tell which way traffic is moving without watching it.
            Part(parent, material, "Lamp", new Vector3(0.06f, 0.14f, 0.24f),
                new Vector3(0.49f, -0.10f, 0f), lamp);
        }

        /// <summary>A floating log: three bark segments and two lighter end grains.</summary>
        public static void BuildLog(Transform parent, Material material, Color bark)
        {
            Color grain = Lift(bark, 0.28f);

            Part(parent, material, "Trunk", new Vector3(1f, 0.7f, 0.9f),
                Vector3.zero, bark);

            // Banding across the length reads as bark rather than as a plank.
            for (int i = 0; i < 2; i++)
            {
                Part(parent, material, "Band", new Vector3(0.06f, 0.74f, 0.94f),
                    new Vector3(-0.18f + i * 0.36f, 0f, 0f), Shade(bark, 0.22f));
            }

            // End grain, so the log has ends.
            foreach (float x in new[] { -0.5f, 0.5f })
            {
                Part(parent, material, "End", new Vector3(0.04f, 0.62f, 0.8f),
                    new Vector3(x, 0f, 0f), grain);
            }
        }

        /// <summary>A tree: trunk plus two staggered canopy blocks.</summary>
        public static void BuildTree(Transform parent, Material material, Color leaf)
        {
            Color trunk = new Color(0.42f, 0.29f, 0.18f);

            Part(parent, material, "Trunk", new Vector3(0.30f, 0.45f, 0.30f),
                new Vector3(0f, -0.28f, 0f), trunk);
            Part(parent, material, "CanopyLow", new Vector3(1f, 0.55f, 1f),
                new Vector3(0f, 0.12f, 0f), leaf);
            // A smaller block offset on top breaks the silhouette, which is what
            // stops a row of trees looking like a row of identical boxes.
            Part(parent, material, "CanopyHigh", new Vector3(0.66f, 0.40f, 0.66f),
                new Vector3(0.06f, 0.50f, -0.05f), Lift(leaf, 0.10f));
        }

        /// <summary>A train: linked carriages with windows and a dark underframe.</summary>
        public static void BuildTrain(Transform parent, Material material, Color body)
        {
            Color glass = new Color(0.18f, 0.22f, 0.28f);

            Part(parent, material, "Body", new Vector3(1f, 0.78f, 1f),
                new Vector3(0f, 0.04f, 0f), body);
            Part(parent, material, "Skirt", new Vector3(1f, 0.24f, 0.86f),
                new Vector3(0f, -0.40f, 0f), Shade(body, 0.45f));

            // A window strip down the flank, broken into carriages. Purely
            // decorative, and enough to stop a train being one long slab.
            for (int i = 0; i < 6; i++)
            {
                float t = (i + 0.5f) / 6f - 0.5f;
                Part(parent, material, "Window", new Vector3(0.10f, 0.26f, 1.02f),
                    new Vector3(t, 0.14f, 0f), glass);
            }
        }

        /// <summary>
        /// The chicken.
        ///
        /// The single most looked-at object in the game, and for a long time it
        /// was one white capsule. Body, head, beak, comb, wattle, tail and two
        /// legs is ten cubes and a sphere, and it is the difference between a
        /// prototype and a game.
        /// </summary>
        public static void BuildChicken(Transform parent, Material material)
        {
            Color feather = new Color(0.98f, 0.98f, 0.96f);
            Color shadow = new Color(0.86f, 0.86f, 0.84f);
            Color comb = new Color(0.90f, 0.22f, 0.20f);
            Color beak = new Color(0.98f, 0.68f, 0.15f);
            Color eye = new Color(0.10f, 0.10f, 0.12f);
            Color leg = new Color(0.95f, 0.60f, 0.12f);

            // Body: a slightly squashed sphere reads rounder than a cube and
            // still fits the blocky world, because everything around it is flat.
            var body = Ball(parent, material, "Body", 1f, new Vector3(0f, 0.02f, 0f), feather);
            body.transform.localScale = new Vector3(0.86f, 0.78f, 0.94f);

            // Wings, one each side, slightly darker so they separate from the body.
            foreach (float x in new[] { -0.40f, 0.40f })
            {
                Part(parent, material, "Wing", new Vector3(0.10f, 0.34f, 0.52f),
                    new Vector3(x, 0.02f, 0.02f), shadow);
            }

            // Tail, angled up and back.
            // Tail, angled up and back, and large — from behind it is the widest
            // part of the silhouette and does most of the work of making the
            // shape read as an animal rather than an egg.
            var tail = Part(parent, material, "Tail", new Vector3(0.26f, 0.46f, 0.34f),
                new Vector3(0f, 0.30f, -0.48f), shadow);
            tail.transform.localRotation = Quaternion.Euler(34f, 0f, 0f);

            // Head, high and well forward.
            //
            // The camera looks down the direction of travel, so the player mostly
            // sees the bird from BEHIND. A head tucked against the body simply
            // disappears from that angle — it has to sit proud of the shoulders
            // or the chicken reads as a featureless white lump, which is what the
            // first version did.
            Ball(parent, material, "Head", 0.50f, new Vector3(0f, 0.56f, 0.34f), feather);

            // Comb: three blocks, tallest at the front, and deliberately large.
            // It is the only red on the model and the main thing that says "bird"
            // from behind, so it is sized to be seen rather than to be accurate.
            for (int i = 0; i < 3; i++)
            {
                Part(parent, material, "Comb", new Vector3(0.11f, 0.22f - i * 0.05f, 0.11f),
                    new Vector3(0f, 0.86f, 0.44f - i * 0.13f), comb);
            }

            Part(parent, material, "Beak", new Vector3(0.15f, 0.11f, 0.22f),
                new Vector3(0f, 0.54f, 0.64f), beak);
            Part(parent, material, "Wattle", new Vector3(0.10f, 0.14f, 0.09f),
                new Vector3(0f, 0.42f, 0.56f), comb);

            foreach (float x in new[] { -0.14f, 0.14f })
            {
                Part(parent, material, "Eye", new Vector3(0.08f, 0.10f, 0.08f),
                    new Vector3(x, 0.62f, 0.52f), eye);
            }

            // Legs. Short, because the body sits low and long legs would make the
            // hop read as a stagger.
            foreach (float x in new[] { -0.17f, 0.17f })
            {
                Part(parent, material, "Leg", new Vector3(0.07f, 0.22f, 0.07f),
                    new Vector3(x, -0.42f, 0.06f), leg);
                Part(parent, material, "Foot", new Vector3(0.16f, 0.06f, 0.22f),
                    new Vector3(x, -0.51f, 0.12f), leg);
            }
        }

        // ── Pop Shot ────────────────────────────────────────────────────────

        /// <summary>
        /// A basketball: sphere plus seams.
        ///
        /// Without seams an orange sphere is an orange dot, and its rotation and
        /// bounce are invisible. The seams cost four thin slabs and make the ball
        /// read as a ball.
        /// </summary>
        public static void BuildBasketball(Transform parent, Material material, Color skin)
        {
            Color seam = Shade(skin, 0.62f);

            var ball = Ball(parent, material, "Skin", 1f, Vector3.zero, skin);
            ball.transform.localScale = Vector3.one;

            // A vertical seam and a horizontal one, plus the two curved side
            // seams a basketball has, approximated as offset bands.
            Part(parent, material, "SeamV", new Vector3(0.055f, 1.01f, 1.01f),
                Vector3.zero, seam);
            Part(parent, material, "SeamH", new Vector3(1.01f, 0.055f, 1.01f),
                Vector3.zero, seam);

            foreach (float x in new[] { -0.34f, 0.34f })
            {
                var side = Part(parent, material, "SeamSide",
                    new Vector3(0.05f, 0.94f, 0.94f), new Vector3(x, 0f, 0f), seam);
                side.transform.localScale = new Vector3(0.05f, 0.90f, 0.90f);
            }
        }

        /// <summary>A hanging net: several strands narrowing towards the bottom.</summary>
        public static void BuildNet(Transform parent, Material material, Color color, float rimWidth)
        {
            const int strands = 7;
            for (int i = 0; i < strands; i++)
            {
                float t = strands == 1 ? 0.5f : i / (float)(strands - 1);
                float x = Mathf.Lerp(-0.5f, 0.5f, t) * rimWidth;
                // Strands lean inward, which is what makes a net look like a cone
                // rather than a curtain.
                var strand = Part(parent, material, "Strand",
                    new Vector3(0.035f, 1f, 0.035f), new Vector3(x * 0.82f, -0.5f, 0f), color);
                strand.transform.localRotation = Quaternion.Euler(0f, 0f, x * 14f);
            }

            // Two hoops around the strands, so it reads as woven.
            for (int i = 0; i < 2; i++)
            {
                Part(parent, material, "Weave",
                    new Vector3(rimWidth * (0.92f - i * 0.22f), 0.035f, 0.035f),
                    new Vector3(0f, -0.30f - i * 0.34f, 0f), color);
            }
        }
    }
}
