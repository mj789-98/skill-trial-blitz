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
        private GameObject _rimLeft;
        private GameObject _rimRight;
        private GameObject _net;
        private GameObject _board;
        private GameObject _floor;
        private GameObject _target;
        private GameObject _rim;
        private GameObject _post;
        private GameObject _arm;

        /// <summary>World units per sub-unit. The sim's court is 9x16 sub-thousands.</summary>
        private const float Scale = 1f / Sim.Sub;

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
            _rim = Build("Rim", rimColor);

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
            _rimLeft = Build("RimLeft", rimColor);
            _rimRight = Build("RimRight", rimColor);
            _net = BuildAssembly("Net", t => Props.BuildNet(t, boardMaterial, netColor, 1f));
            // A basketball, not an orange dot: sphere plus seams. Without them
            // the ball has no surface detail at all, so its bounce and travel
            // read as a sliding disc rather than a rolling object.
            _ball = BuildAssembly("Ball", t => Props.BuildBasketball(t, boardMaterial, ballColor));
            _ghost = BuildAssembly("BallWrapped",
                t => Props.BuildBasketball(t, boardMaterial, ballColor));

            BuildCourt();
            BuildFence();
        }

        /// <summary>A cube placed by its centre, in world units.</summary>
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
            go.transform.localPosition = new Vector3(x, y, z);
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

            // How much room there is below the floor line is a property of the
            // DEVICE, not of the court.
            //
            // FrameCourt sizes the camera from the court's width, so the height
            // it ends up showing depends on the surface aspect: this phone
            // leaves about 1.2 units below y=0, and a 16:9 screen leaves none at
            // all — the clamp in FrameCourt puts the bottom of the view exactly
            // on the floor line. The first two attempts at this court were laid
            // out in absolute units and hung off the bottom of the frame.
            //
            // So everything below the floor is sized to fit 1.1 units and is
            // understood to be a bonus on tall screens rather than something the
            // game needs. The one piece that must always be visible is the fence
            // rail, and that is drawn straddling y=0 for exactly this reason.
            const float courtMid = -0.72f;
            const float courtH = 0.62f;

            Slab("CourtPaint", courtPaint, w * 0.5f, floorY + courtMid, w * 0.94f, courtH, 1.0f);

            // Sideline, centre line and the two keys — the markings that say
            // "basketball court" with four rectangles.
            var key = new Color(0.66f, 0.28f, 0.24f);
            Slab("KeyLeft", key, w * 0.20f, floorY + courtMid, 1.6f, courtH * 0.62f, 0.9f);
            Slab("KeyRight", key, w * 0.80f, floorY + courtMid, 1.6f, courtH * 0.62f, 0.9f);
            Slab("Sideline", lineColor, w * 0.5f, floorY + courtMid + courtH * 0.5f,
                w * 0.94f, 0.05f, 0.85f);
            Slab("CentreLine", lineColor, w * 0.5f, floorY + courtMid, 0.05f, courtH, 0.85f);
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
            camera.orthographicSize = Mathf.Max(size, Sim.CourtH * Scale * 0.5f);

            camera.transform.position = new Vector3(
                Sim.CourtW * Scale * 0.5f,
                Sim.CourtH * Scale * 0.5f,
                -20f);
        }

        /// <summary>
        /// The hoop moves with the seed, so the court is laid out per round rather
        /// than once. Cheap, and it means a new seed cannot leave a stale rim.
        /// </summary>
        private void LayoutCourt(Sim.State state)
        {
            float hoopX = state.HoopXPos * Scale;
            float hoopY = Sim.HoopY * Scale;
            float rimHalf = Sim.RimHalf * Scale;
            float postD = Sim.PostR * 2f * Scale;

            // Meets the ball's resting height exactly, so the ball sits ON the
            // floor rather than hovering above a slab.
            float floorTop = Sim.FloorY * Scale - Sim.BallR * Scale;
            // Thinner than it was, and pushed back: it is now the boards under
            // the painted court rather than the only object at the bottom of
            // the frame.
            _floor.transform.localScale = new Vector3(Sim.CourtW * Scale, 1.0f, 0.4f);
            _floor.transform.localPosition =
                new Vector3(Sim.CourtW * Scale * 0.5f, floorTop - 0.62f, 1.3f);

            _rimLeft.transform.localScale = new Vector3(postD, postD, postD);
            _rimLeft.transform.localPosition = new Vector3(hoopX - rimHalf, hoopY, 0f);

            _rimRight.transform.localScale = new Vector3(postD, postD, postD);
            _rimRight.transform.localPosition = new Vector3(hoopX + rimHalf, hoopY, 0f);

            // The ring, closing the gap between the posts.
            _rim.transform.localScale = new Vector3(rimHalf * 2f + postD, postD * 0.72f, postD * 0.9f);
            _rim.transform.localPosition = new Vector3(hoopX, hoopY, 0f);

            // The net hangs FROM the ring, so its top edge meets the rim exactly.
            // The first version floated a slab below the hoop with a visible gap,
            // which read as an unrelated object.
            const float netHeight = 0.55f;
            _net.transform.localScale = new Vector3(rimHalf * 1.7f, netHeight, 0.04f);
            _net.transform.localPosition = new Vector3(hoopX, hoopY - netHeight * 0.5f, 0.3f);

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
            float poleX = boardX + 0.55f;
            float poleTop = hoopY + Sim.BoardH * Scale * 0.75f;
            float poleHeight = poleTop - poleBase;
            // Behind the play plane. At z=0.15 the pole was drawn in front of
            // the whole scene, so it read as a line ruled down the city rather
            // than as something holding the hoop up.
            _post.transform.localScale = new Vector3(0.20f, poleHeight, 0.20f);
            _post.transform.localPosition =
                new Vector3(poleX, poleBase + poleHeight * 0.5f, 0.5f);

            _arm.transform.localScale = new Vector3(0.62f, 0.14f, 0.14f);
            _arm.transform.localPosition = new Vector3(boardX + 0.28f, hoopY + 0.35f, 0.45f);
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
