using UnityEngine;
using SkillApp.ChickenRun.View;
using SkillApp.PopShot.Simulation;

namespace SkillApp.PopShot.View
{
    /// <summary>
    /// Renders the Pop Shot court from simulation state.
    ///
    /// Owns no rules. It reads Sim.State and draws it, and the only numbers it
    /// invents are the ones between two ticks — the interpolation that makes 50Hz
    /// logic look smooth at 120fps.
    ///
    /// ── The wrap has to be drawn twice ───────────────────────────────────────
    ///
    /// The ball wraps at the court edges, which is a hard cut in world space and
    /// would read as the ball teleporting. So a second ball is drawn one court
    /// width away, and near an edge both are on screen: one leaving, one already
    /// arriving. It costs one extra cube and turns the game's strangest mechanic
    /// into something a player reads instantly.
    /// </summary>
    public class PopShotView : MonoBehaviour
    {
        [SerializeField] private PopShotGame game;
        [SerializeField] private new Camera camera;
        [SerializeField] private Material boardMaterial;

        [Header("Camera")]
        /// <summary>
        /// How far the camera looks DOWN at the court, in degrees.
        ///
        /// It was zero, and zero is why the hoop never read as a hoop. Dead-on,
        /// a rim is a horizontal bar — there is no opening to see, so the basket
        /// looked like a shelf the ball passed behind. The reference camera is
        /// tilted, which is what turns the rim into an ellipse you can see
        /// through and the court into a surface receding away from you.
        ///
        /// Measured off the reference: its rim ellipse is about 0.31 as tall as
        /// it is wide, and asin(0.31) is 18 degrees.
        ///
        /// This is free for the simulation. The ball moves in the z=0 plane, and
        /// an orthographic camera pitched by theta maps that plane to
        /// screen_y = y*cos(theta) — a uniform scale, not a distortion. Nothing
        /// about the physics or the replay changes; only the picture does.
        /// </summary>
        [SerializeField] private float pitch = 18f;

        [Header("Palette")]
        [SerializeField] private Color courtColor = new Color(0.83f, 0.53f, 0.31f);
        [SerializeField] private Color lineColor = new Color(0.95f, 0.92f, 0.86f);
        [SerializeField] private Color ballColor = new Color(0.93f, 0.45f, 0.16f);
        [SerializeField] private Color rimColor = new Color(0.90f, 0.24f, 0.16f);
        [SerializeField] private Color boardColor = new Color(0.96f, 0.96f, 0.96f);
        [SerializeField] private Color netColor = new Color(0.88f, 0.88f, 0.90f);

        [Header("Scene")]
        /// Everything behind the play plane is deliberately dark and desaturated.
        /// The ball is the only saturated orange in the frame and the rim the only
        /// red, and that is what makes both readable against a busy backdrop.
        [SerializeField] private Color asphalt = new Color(0.11f, 0.12f, 0.16f);
        [SerializeField] private Color kerb = new Color(0.20f, 0.21f, 0.26f);
        [SerializeField] private Color pavement = new Color(0.16f, 0.17f, 0.21f);
        [SerializeField] private Color brickA = new Color(0.15f, 0.13f, 0.16f);
        [SerializeField] private Color brickB = new Color(0.12f, 0.14f, 0.17f);
        /// Dim on purpose. The first version used a full-strength warm yellow
        /// and put forty of them across the facade, which made the busiest part
        /// of the frame the part directly behind the rim.
        [SerializeField] private Color window = new Color(0.55f, 0.44f, 0.24f);
        [SerializeField] private Color steel = new Color(0.42f, 0.46f, 0.53f);
        [SerializeField] private Color woodFloor = new Color(0.44f, 0.30f, 0.18f);
        [SerializeField] private Color courtPaint = new Color(0.30f, 0.44f, 0.55f);

        private Transform _root;
        private GameObject _ball;
        private GameObject _ghost;
        private GameObject _board;
        private GameObject _floor;
        private GameObject _target;
        private GameObject _hoop;
        private GameObject _post;
        private GameObject _arm;

        /// <summary>
        /// The net, separate from the rim so it can move while the rim cannot.
        /// </summary>
        private Transform _net;

        /// <summary>
        /// How far the net is currently pushed out of shape, 0 to 1.
        ///
        /// View-only and frame-timed, deliberately. Nothing the server replays
        /// depends on it, so it must not consume sim state or a tick count —
        /// if it did, a dropped frame would become a scoring difference.
        /// </summary>
        private float _netBulge;

        /// <summary>World units per sub-unit. The sim's court is 9x16 sub-thousands.</summary>
        private const float Scale = 1f / Sim.Sub;

        /// <summary>How deep the net hangs below the rim, in world units.</summary>
        /// <remarks>
        /// 0.9 of the rim's diameter, measured off the reference recording.
        /// Class-level because the ball-through-the-net test needs the same
        /// number the geometry was built from; two copies would drift.
        /// </remarks>
        private const float NetDrop = 0.9f * 2f * Sim.RimHalf * Scale;

        private const float NetPinch = 0.52f;

        private void Awake()
        {
            _root = new GameObject("PopShotWorld").transform;
            _root.SetParent(transform, false);

            // The backdrop goes down FIRST so everything built after it is
            // drawn in front. Depth sorting here is by z, not by order, but
            // building it in reading order keeps the code legible.
            BuildBackdrop();

            _floor = Build("Floor", woodFloor);
            // The ring itself, spanning the two posts.
            //
            // Without it the hoop is two small red squares with a gap between
            // them, which reads as two markers rather than as a basket — the eye
            // needs the bar to close the shape. Seen edge-on from a 2D camera a
            // ring IS a bar, so this is both correct and free.
            _hoop = BuildHoop();

            // A stanchion, so the hoop is MOUNTED rather than floating.
            //
            // This replaces a painted target square on the backboard, which was
            // a mistake I could only see once it was on screen: the camera looks
            // straight down the court's depth axis, so the backboard is edge-on
            // and its face — and anything painted on it — is invisible by
            // construction. A square that cannot be seen is not detail, it is
            // three wasted draw calls and one stray red stripe where a bar
            // happened to catch the light.
            //
            // What the eye actually wanted was for the hoop to be attached to
            // something.
            _post = Build("Stanchion", new Color(0.42f, 0.45f, 0.52f));
            _arm = Build("Arm", new Color(0.42f, 0.45f, 0.52f));
            _board = Build("Backboard", boardColor);
            // A basketball, not an orange dot: sphere plus seams. Without them
            // the ball has no surface detail at all, so its bounce and travel
            // read as a sliding disc rather than a rolling object.
            _ball = BuildAssembly("Ball", t => Props.BuildBasketball(t, boardMaterial, ballColor));
            _ghost = BuildAssembly("BallWrapped",
                t => Props.BuildBasketball(t, boardMaterial, ballColor));

            BuildCourt();
            BuildFence();
        }

        /// <summary>
        /// A cube placed by its centre, in world units.
        ///
        /// The z argument is a DEPTH BAND, and the bands matter: the camera looks
        /// straight down this axis, so a thick slab at a small z hides everything
        /// behind it. The first version of the scene put the floor at z=0.35 with
        /// a full unit of depth, which swallowed the fence and every court
        /// marking — they were drawn, they were just inside the floor.
        ///
        ///   0.0  ball, rim, posts, net       the play plane
        ///   0.5  fence, stanchion            just behind the ball
        ///   0.9  court markings
        ///   1.3  floor boards
        ///   6-7  street and buildings
        ///
        /// Each slab is 0.4 deep, so a band cannot reach into its neighbour.
        /// </summary>
        private GameObject Slab(string name, Color c, float x, float y, float w, float h, float z)
        {
            var go = Build(name, c);
            go.transform.localScale = new Vector3(w, h, 0.4f);
            go.transform.localPosition = new Vector3(x, y - DepthRise(z), z);
            return go;
        }

        /// <summary>
        /// How far up the screen a thing at depth `z` floats, in world units.
        ///
        /// With the camera pitched down, screen height is y*cos(t) + z*sin(t):
        /// the further back something is, the HIGHER it is drawn. The backdrop
        /// sits six to seven units back, so without correcting for this the
        /// whole street would ride two units above where it was placed and the
        /// buildings would hang in the air.
        ///
        /// Subtracting z*tan(t) makes every y argument in this file mean the
        /// same thing it meant before the camera moved: the height it appears
        /// at. Which is the only reason the layout numbers still read sensibly.
        /// </summary>
        private float DepthRise(float z) => z * Mathf.Tan(pitch * Mathf.Deg2Rad);

        /// <summary>
        /// A flat, horizontal panel: thin in y, extended in x and z.
        ///
        /// The counterpart to Slab. A Slab is a wall and faces the camera; a
        /// Plate is a floor and is seen at the pitch angle, so its DEPTH becomes
        /// its height on screen. That is the whole reason the court reads as
        /// ground rather than as a picture of ground.
        /// </summary>
        private GameObject Plate(
            string name, Color c, float y, float z, float w, float d)
        {
            var go = Build(name, c);
            go.transform.localScale = new Vector3(w, 0.05f, d);
            // No DepthRise here, unlike Slab. A plate's whole job is that its
            // depth becomes screen height, so its y is a real world height and
            // the tilt is left to do exactly what it is there to do.
            go.transform.localPosition = new Vector3(Sim.CourtW * Scale * 0.5f, y, z);
            return go;
        }

        /// <summary>A cube with a rotation, for anything not axis-aligned.</summary>
        private GameObject Piece(
            Transform parent, string name, Color c,
            Vector3 pos, Vector3 scale, Quaternion rot)
        {
            var go = PrimitiveMesh.CubeObject(name, boardMaterial);
            go.transform.SetParent(parent, false);
            go.transform.localPosition = pos;
            go.transform.localScale = scale;
            go.transform.localRotation = rot;
            Tint(go, c);
            return go;
        }

        /// <summary>
        /// The basket: a ring lying in the horizontal plane, with a net hanging
        /// from it.
        ///
        /// This is the piece the camera pitch exists for. A rim is a circle in
        /// the x-z plane, and a pitched camera projects a circle to an ellipse —
        /// so the ring is built as an actual ring, twenty-four short bars around
        /// a circle of the simulation's own RIM_HALF radius, and the projection
        /// does the rest. Its widest points sit exactly where the simulation
        /// puts the two rim posts, so what you aim at is what you collide with.
        ///
        /// The net follows from that: twelve strands from the ring, converging
        /// inward and downward into a cone, bound by three hoops of cord. Drawn
        /// dead-on, a cone of strands is a flat grid — which is precisely what
        /// the old net was, and why it read as a fence panel hanging under a
        /// shelf.
        ///
        /// The ball plays at z=0 and the ring is centred there, so the near arc
        /// of the rim and the near strands are genuinely in FRONT of the ball
        /// while the far ones are behind it. Nothing special-cases that — it is
        /// a real ring, a real ball and a depth buffer — and it is what makes a
        /// made basket read as going through rather than past.
        /// </summary>
        private GameObject BuildHoop()
        {
            var go = new GameObject("Hoop");
            go.transform.SetParent(_root, false);

            float r = Sim.RimHalf * Scale;
            const int segments = 24;
            float bar = 2f * Mathf.PI * r / segments * 1.35f;
            // Thin, and it has to be. The pitch squashes the ellipse to a third
            // of its width, so a bar as thick as the simulation's rim post is
            // half the height of the whole ring — the first attempt looked like
            // a crown of red bricks rather than a hoop.
            const float thick = 0.06f;

            for (int i = 0; i < segments; i++)
            {
                float a = 2f * Mathf.PI * i / segments;
                Piece(go.transform, $"Rim{i}", rimColor,
                    new Vector3(Mathf.Cos(a) * r, 0f, Mathf.Sin(a) * r),
                    new Vector3(bar, thick, thick),
                    // Tangential: the bar runs ALONG the circle, not across it.
                    //
                    // The -90 is the whole difference. A cube's long axis is X,
                    // and yawing by -a points X at the circle's RADIUS, so the
                    // first version drew twenty-four bars pointing outwards — a
                    // wreath of red dashes rather than a rim.
                    Quaternion.Euler(0f, -a * Mathf.Rad2Deg - 90f, 0f));
            }

            // ── Net depth, measured rather than eyeballed ────────────────────
            //
            // This was 0.55, which is 0.31 of the rim's diameter. Measured off
            // the reference recording -- pale pixels below the rim, over the
            // middle third of its width, on frames where the ball was not in
            // the way -- the real ratio is 0.91 and 0.96 on two clean reads.
            //
            // The old number was not merely short, it was SHORTER THAN THE BALL
            // IS WIDE: net 0.55 against a ball of 0.68. A ball cannot travel
            // down a net shallower than itself, so it clipped a skirt and came
            // out the far side, which is exactly the "it does not go through
            // the net" the reference makes obvious.
            //
            // 0.9 of the diameter, so it scales if RIM_HALF ever changes.
            // Wider at the mouth than the old 0.45 too: the bottom opening has
            // to stay clear of the ball or the net reads as a bag the ball
            // sticks in. At 0.52 the opening is 0.94 across against a 0.68 ball.
            const int strands = 12;
            const float netDrop = NetDrop;
            const float netPinch = NetPinch;

            // The net hangs off its own transform so it can be deformed without
            // touching the rim. The rim is what the simulation collides with and
            // it must never move a millimetre for a visual effect.
            var netGo = new GameObject("Net");
            netGo.transform.SetParent(go.transform, false);
            _net = netGo.transform;

            for (int i = 0; i < strands; i++)
            {
                float a = 2f * Mathf.PI * i / strands;
                var top = new Vector3(Mathf.Cos(a) * r, 0f, Mathf.Sin(a) * r);
                var bottom = new Vector3(
                    Mathf.Cos(a) * r * netPinch, -netDrop, Mathf.Sin(a) * r * netPinch);

                var mid = (top + bottom) * 0.5f;
                var dir = bottom - top;

                Piece(_net, $"Strand{i}", netColor,
                    mid, new Vector3(0.022f, dir.magnitude, 0.022f),
                    Quaternion.FromToRotation(Vector3.up, dir.normalized));
            }

            // Hoops of cord around the strands, so they read as mesh rather
            // than as a dozen unrelated wires.
            //
            // Three of them, not one. One was enough when the net was a 0.55
            // skirt; across a drop three times deeper a single ring leaves two
            // long unbroken runs and the cone goes back to looking like hanging
            // string. The spacing tightens towards the bottom because that is
            // what a real net does -- the cord bunches where the cone pinches.
            float[] ringAt = { 0.28f, 0.58f, 0.84f };
            foreach (float t in ringAt)
            {
                float rr = r * (1f - (1f - netPinch) * t);
                for (int i = 0; i < segments; i++)
                {
                    float a = 2f * Mathf.PI * i / segments;
                    Piece(_net, $"NetRing{t:0.00}_{i}", netColor,
                        new Vector3(Mathf.Cos(a) * rr, -netDrop * t, Mathf.Sin(a) * rr),
                        new Vector3(2f * Mathf.PI * rr / segments * 1.35f, 0.022f, 0.022f),
                        Quaternion.Euler(0f, -a * Mathf.Rad2Deg - 90f, 0f));
                }
            }

            return go;
        }

        /// <summary>
        /// The street the court sits on, and the city behind it.
        ///
        /// Not decoration for its own sake. The court is nine units wide and
        /// sixteen tall, the camera frames all of it, and the ball occupies
        /// under one percent of that area — so with an empty background the game
        /// read as a dot moving in a void, with nothing to judge the ball's
        /// height or speed against. The reference solves this with a full street
        /// scene, and the reason it works is parallax by proxy: fixed landmarks
        /// at known heights turn "the ball is somewhere" into "the ball is above
        /// the shop fronts".
        ///
        /// Built once, never touched again, and every piece sits at positive z
        /// so nothing can ever occlude the ball, the rim or the net.
        /// </summary>
        private void BuildBackdrop()
        {
            float w = Sim.CourtW * Scale;
            float h = Sim.CourtH * Scale;

            // Road surface, from the fence line up to the far kerb.
            //
            // The terrace starts at 7.5 and the rim is fixed at 9.5, so the hoop
            // hangs a little above the shop fronts — which is where the
            // reference puts it, and it is why the rim reads as being ON a
            // street rather than floating in a skyline.
            const float kerbY = 6.9f;
            Slab("Asphalt", asphalt, w * 0.5f, kerbY * 0.5f, w, kerbY, 6f);
            Slab("Kerb", kerb, w * 0.5f, kerbY + 0.07f, w, 0.14f, 6f);

            // Lane markings. Barely lighter than the road on purpose: the ball
            // spends the whole round in front of this, so the markings are here
            // to give height a reference, not to be looked at. Two lines at
            // known heights are enough to tell a high ball from a low one.
            foreach (float y in new[] { 2.1f, 4.4f })
            {
                for (int i = 0; i < 5; i++)
                {
                    Slab("Lane", Props.Lift(asphalt, 0.06f),
                        w * (0.1f + i * 0.2f), y, w * 0.11f, 0.05f, 5.9f);
                }
            }
            Slab("Pavement", pavement, w * 0.5f, kerbY + 0.44f, w, 0.6f, 6f);

            // A terrace of buildings. Fixed rather than seeded: the backdrop is
            // not part of the game, and a skyline that changed every round would
            // be one more thing moving for no reason.
            float[,] terrace =
            {
                // x, width, height
                { 0.00f, 1.70f, 5.4f },
                { 1.70f, 1.15f, 7.1f },
                { 2.85f, 1.45f, 4.6f },
                { 4.30f, 1.05f, 8.2f },
                { 5.35f, 1.75f, 6.0f },
                { 7.10f, 1.20f, 7.6f },
                { 8.30f, 0.70f, 5.0f },
            };

            for (int i = 0; i < terrace.GetLength(0); i++)
            {
                float bx = terrace[i, 0];
                float bw = terrace[i, 1];
                float bh = terrace[i, 2];
                const float baseY = 7.5f;

                var brick = (i % 2 == 0) ? brickA : brickB;
                Slab($"Building{i}", brick, bx + bw * 0.5f, baseY + bh * 0.5f, bw, bh, 7f);

                // Lit windows. Two columns, and as many rows as the building is
                // tall — so a taller building reads as taller rather than just
                // as a bigger rectangle.
                int rows = Mathf.Max(1, Mathf.FloorToInt(bh / 1.6f));
                for (int r = 0; r < rows; r++)
                {
                    for (int c = 0; c < 2; c++)
                    {
                        // Not every window is lit; a fully lit facade looks like
                        // a grid rather than like a building at night.
                        if (((i * 7 + r * 3 + c) % 3) != 0) continue;

                        float wx = bx + bw * (c == 0 ? 0.30f : 0.70f);
                        float wy = baseY + 0.9f + r * 1.6f;
                        Slab($"Win{i}_{r}_{c}", window, wx, wy, bw * 0.13f, 0.30f, 6.9f);
                    }
                }
            }

            // Ground-floor shop fronts. A thin lit strip rather than the row of
            // gold boxes this started as — at that size they read as objects in
            // the scene rather than as lights on a wall behind it.
            for (int i = 0; i < 6; i++)
            {
                Slab($"Shop{i}", Props.Shade(window, 0.30f),
                    0.85f + i * 1.45f, 7.95f, 0.85f, 0.26f, 6.9f);
            }

            // Sky above the terrace is the camera's clear colour; nothing to
            // build, and a solid night sky is what the reference has too.
            _ = h;
        }

        /// <summary>
        /// The painted court below the fence.
        ///
        /// The simulation's floor is the fence rail, so none of this is playable
        /// — it is the ground the court stands on, and it exists because the
        /// bottom of the frame was otherwise a hard edge between orange slab and
        /// black.
        /// </summary>
        private void BuildCourt()
        {
            float w = Sim.CourtW * Scale;
            float floorY = Sim.FloorY * Scale - Sim.BallR * Scale;

            // The court is a FLOOR, so it is laid out flat in x-z and comes
            // TOWARDS the viewer rather than being painted on an upright slab.
            // With the camera pitched, that is what makes it read as ground you
            // are looking down at — the same trick as the rim, applied to the
            // largest surface in the frame.
            //
            // It also retires a problem rather than solving it. Laid out
            // upright, the court had to fit in the sliver of world visible below
            // the floor line, and how big that sliver is depends on the DEVICE —
            // this phone leaves about 1.2 units, a 16:9 screen leaves none, and
            // two attempts hung off the bottom of the frame. Laid out flat, its
            // height on screen comes from its DEPTH, which no screen shape can
            // take away.
            //
            // ── Why y is what it is ──────────────────────────────────────────
            //
            // Screen height is y*cos(t) + z*sin(t), so a surface coming towards
            // the viewer falls DOWN the screen as it approaches. The court's far
            // edge is therefore its HIGHEST point, and it has to land just under
            // the fence — otherwise the near half of the court is drawn over the
            // ball, which is what the first flat version did: the court sat in
            // front of the play plane in z and swallowed the ball at rest.
            //
            //   far edge  z = +0.4  ->  screen -0.50  (just below the fence foot)
            //   near edge z = -2.8  ->  screen -1.49  (bottom of the frame)
            //
            // Nothing here is playable. The simulation's floor is the fence
            // rail; this is only what the court stands on.
            const float courtY = -0.66f;
            const float courtZ = -1.20f;
            const float courtD = 3.20f;

            Plate("CourtBoards", woodFloor, courtY, courtZ, w, courtD);
            Plate("CourtPaint", courtPaint, courtY + 0.01f, courtZ, w * 0.90f, courtD * 0.86f);

            var key = new Color(0.66f, 0.28f, 0.24f);
            var keyL = Plate("KeyLeft", key, courtY + 0.02f, courtZ, 1.7f, courtD * 0.50f);
            keyL.transform.localPosition += new Vector3(-w * 0.30f, 0f, 0f);
            var keyR = Plate("KeyRight", key, courtY + 0.02f, courtZ, 1.7f, courtD * 0.50f);
            keyR.transform.localPosition += new Vector3(w * 0.30f, 0f, 0f);

            Plate("HalfWay", lineColor, courtY + 0.03f, courtZ, 0.06f, courtD * 0.86f);
            Plate("Baseline", lineColor, courtY + 0.03f, courtZ - courtD * 0.43f, w * 0.90f, 0.06f);
            Plate("FarLine", lineColor, courtY + 0.03f, courtZ + courtD * 0.43f, w * 0.90f, 0.06f);
        }

        /// <summary>
        /// The fence the ball bounces off.
        ///
        /// This is the one piece of scenery that is not scenery: the simulation
        /// bounces the ball at FloorY, and until now nothing was drawn there, so
        /// the ball rebounded off thin air. A rail at exactly that height turns
        /// an unexplained bounce into an obvious one.
        /// </summary>
        private void BuildFence()
        {
            float w = Sim.CourtW * Scale;
            float top = Sim.FloorY * Scale - Sim.BallR * Scale;

            // The rail STRADDLES the floor line rather than hanging below it.
            // On a 16:9 screen the camera bottom lands exactly on y=0, so a rail
            // drawn below it would be the one piece of this scene that matters
            // and the one piece nobody sees.
            Slab("FenceTop", steel, w * 0.5f, top + 0.03f, w, 0.11f, 0.5f);
            Slab("FenceFoot", steel, w * 0.5f, top - 0.40f, w, 0.06f, 0.5f);

            // Chain link, suggested by uprights rather than modelled.
            for (int i = 0; i <= 16; i++)
            {
                Slab($"FenceWire{i}", Props.Shade(steel, 0.25f),
                    w * i / 16f, top - 0.20f, 0.03f, 0.40f, 0.52f);
            }

            // Posts, thicker, at the ends and the middle.
            foreach (float x in new[] { 0.06f, w * 0.5f, w - 0.06f })
            {
                Slab("FencePost", steel, x, top - 0.19f, 0.09f, 0.46f, 0.48f);
            }
        }

        private GameObject Build(string name, Color color)
        {
            // PrimitiveMesh, not GameObject.CreatePrimitive: the Physics module is
            // stripped from player builds and CreatePrimitive attaches a collider.
            // See PrimitiveMesh for the crash this avoids.
            var go = PrimitiveMesh.CubeObject(name, boardMaterial);
            go.transform.SetParent(_root, false);
            Tint(go, color);
            return go;
        }

        /// <summary>An empty parent holding a composite prop, scaled like a cube.</summary>
        private GameObject BuildAssembly(string name, System.Action<Transform> build)
        {
            var go = new GameObject(name);
            go.transform.SetParent(_root, false);
            build(go.transform);
            return go;
        }

        private static void Tint(GameObject go, Color color)
        {
            var r = go.GetComponent<MeshRenderer>();
            var block = new MaterialPropertyBlock();
            r.GetPropertyBlock(block);
            // URP Unlit uses _BaseColor; the built-in fallback uses _Color.
            block.SetColor("_BaseColor", color);
            block.SetColor("_Color", color);
            r.SetPropertyBlock(block);
        }

        private void LateUpdate()
        {
            var state = game != null ? game.State : null;
            if (state == null) return;

            FrameCourt();
            LayoutCourt(state);
            LayoutBall(state);
            AnimateNet(state);
        }

        /// <summary>
        /// Push the net out of shape while the ball is inside it.
        ///
        /// A ball passing through rigid geometry does not read as a made
        /// basket; it reads as clipping. The net has to give. That is the whole
        /// difference between the ball going THROUGH the net and the ball going
        /// PAST it, and no amount of extra net detail substitutes for it.
        ///
        /// Driven off the ball's own position rather than off the scoring
        /// event, so it is right during the shot instead of a beat after it,
        /// and so a ball that drops in and rattles out still moves the net.
        ///
        /// Strictly cosmetic. It scales a transform that holds no collider —
        /// the rim the simulation collides with is a sibling and never moves.
        /// The decay is frame-timed rather than tick-timed for the same reason:
        /// nothing the server replays may depend on the frame rate.
        /// </summary>
        private void AnimateNet(Sim.State state)
        {
            if (_net == null) return;

            float rim = Sim.RimHalf * Scale;
            float ballR = Sim.BallR * Scale;
            float hoopX = state.HoopXPos * Scale;
            float hoopY = state.HoopYPos * Scale;

            float bx = state.X * Scale;
            float by = state.Y * Scale;

            // Inside the cone: within the rim horizontally, and between the rim
            // and the bottom of the net vertically. The ball's radius is
            // included at both ends so the net starts giving as the ball
            // arrives rather than once its centre is already through.
            bool inside =
                Mathf.Abs(bx - hoopX) < rim + ballR &&
                by < hoopY + ballR &&
                by > hoopY - NetDrop - ballR;

            // Snap out, ease back. A net is caught quickly and settles slowly,
            // and matching that is most of why the motion reads as cloth.
            float target = inside ? 1f : 0f;
            float rate = inside ? 22f : 5f;
            _netBulge = Mathf.MoveTowards(_netBulge, target, rate * Time.deltaTime);

            // Swell across, stretch down. Uniform in x and z so the bulge is
            // round from every angle the camera can be at.
            float swell = 1f + 0.30f * _netBulge;
            float stretch = 1f + 0.22f * _netBulge;
            _net.localScale = new Vector3(swell, stretch, swell);
        }

        /// <summary>
        /// Fit the whole court width on screen.
        ///
        /// orthographicSize is HALF the view HEIGHT, and on a 9:20 phone framing
        /// by height crops the sides: the court is 9 units wide and a 16-unit
        /// view is only 7.2 units across. The first device build lost nearly two
        /// columns off the left, taking most of the floor with them.
        ///
        /// Width is the binding dimension in portrait, so size is derived from it
        /// — the same reasoning as Chicken Run's CameraRig, and re-derived every
        /// frame so a resize cannot crop the court back out of view.
        /// </summary>
        private void FrameCourt()
        {
            if (camera == null) return;

            float aspect = camera.aspect > 0.01f ? camera.aspect : 0.5f;
            float size = (Sim.CourtW * Scale * 0.5f) / aspect;

            // Never smaller than the court is tall, or a very wide screen would
            // crop the hoop off the top instead.
            //
            // The pitch compresses the play plane vertically by cos(pitch), so
            // the height that has to fit is slightly less than the court's —
            // which is why tilting the camera also bought back the room under
            // the floor line that the court needed.
            float cos = Mathf.Cos(pitch * Mathf.Deg2Rad);
            camera.orthographicSize =
                Mathf.Max(size, Sim.CourtH * Scale * 0.5f * cos);

            // Look DOWN at the play plane from in front of it. The camera is
            // placed back along its own view direction, so the point it is
            // aimed at stays the centre of the court whatever the pitch is.
            camera.transform.rotation = Quaternion.Euler(pitch, 0f, 0f);

            var target = new Vector3(
                Sim.CourtW * Scale * 0.5f, Sim.CourtH * Scale * 0.5f, 0f);
            camera.transform.position = target - camera.transform.forward * 24f;
        }

        /// <summary>
        /// The hoop moves with the seed, so the court is laid out per round rather
        /// than once. Cheap, and it means a new seed cannot leave a stale rim.
        /// </summary>
        private void LayoutCourt(Sim.State state)
        {
            float hoopX = state.HoopXPos * Scale;
            // From the state, not the constant. The rim's height is re-drawn on
            // every basket now, and a view still reading a constant would
            // render a basket the ball does not go through.
            float hoopY = state.HoopYPos * Scale;

            // Which way the basket faces. The backboard, pole and arm all stand
            // OUTBOARD of the rim so it opens into the court, so all three
            // mirror when the basket changes lanes.
            float outward = state.HoopXPos * 2 >= Sim.CourtW ? 1f : -1f;

            // Meets the ball's resting height exactly, so the ball sits ON the
            // floor rather than hovering above a slab.
            float floorTop = Sim.FloorY * Scale - Sim.BallR * Scale;
            // A skirt under the fence, filling the sliver between the fence foot
            // and the far edge of the court.
            _floor.transform.localScale = new Vector3(Sim.CourtW * Scale, 0.22f, 0.4f);
            _floor.transform.localPosition = new Vector3(
                Sim.CourtW * Scale * 0.5f, floorTop - 0.50f - DepthRise(0.5f), 0.5f);

            // Ring and net are one assembly built around the origin, so the
            // whole basket moves with a single transform. The ball plays at z=0
            // and the ring is centred there, so the ball passes THROUGH the
            // middle of it rather than in front of it.
            _hoop.transform.localPosition = new Vector3(hoopX, hoopY, 0f);

            float boardX = Sim.BoardX(state) * Scale;
            _board.transform.localScale =
                new Vector3(Sim.BoardThick * 2f * Scale, Sim.BoardH * Scale, 0.6f);
            _board.transform.localPosition =
                new Vector3(boardX, hoopY + Sim.BoardH * Scale * 0.5f, 0.1f);

            // Stanchion: a pole up to the backboard, and a short arm out to it.
            //
            // It stands on the PAVEMENT rather than on the court. Running it to
            // the floor line made it eleven units long, crossing the entire
            // frame as a thin vertical line with nothing to do — and it was
            // wrong besides. The hoop is on the street, behind the fence, which
            // is where the reference mounts it too.
            const float poleBase = 6.9f;
            float poleX = boardX + 0.55f * outward;
            float poleTop = hoopY + Sim.BoardH * Scale * 0.75f;
            float poleHeight = poleTop - poleBase;
            // Behind the play plane. At z=0.15 the pole was drawn in front of
            // the whole scene, so it read as a line ruled down the city rather
            // than as something holding the hoop up.
            _post.transform.localScale = new Vector3(0.20f, poleHeight, 0.20f);
            _post.transform.localPosition =
                new Vector3(poleX, poleBase + poleHeight * 0.5f, 0.5f);

            _arm.transform.localScale = new Vector3(0.62f, 0.14f, 0.14f);
            _arm.transform.localPosition =
                new Vector3(boardX + 0.28f * outward, hoopY + 0.35f, 0.45f);
        }

        private void LayoutBall(Sim.State state)
        {
            // Interpolate between the last two ticks. The sim is 50Hz; the screen
            // is not, and snapping 50 times a second looks like stutter.
            float a = game.TickAlpha;
            float x = Mathf.Lerp(game.PrevX, state.X, a) * Scale;
            float y = Mathf.Lerp(game.PrevY, state.Y, a) * Scale;

            // A wrap is a discontinuity: interpolating across it would drag the
            // ball backwards through the whole court in one frame.
            if (Mathf.Abs(state.X - game.PrevX) > Sim.CourtW / 2)
            {
                x = state.X * Scale;
                y = state.Y * Scale;
            }

            float d = Sim.BallR * 2f * Scale;
            _ball.transform.localScale = new Vector3(d, d, d);
            _ball.transform.localPosition = new Vector3(x, y, 0f);

            // The wrapped twin, on whichever side the ball is closest to.
            float courtW = Sim.CourtW * Scale;
            float ghostX = x < courtW * 0.5f ? x + courtW : x - courtW;
            _ghost.transform.localScale = _ball.transform.localScale;
            _ghost.transform.localPosition = new Vector3(ghostX, y, 0f);
        }
    }
}
