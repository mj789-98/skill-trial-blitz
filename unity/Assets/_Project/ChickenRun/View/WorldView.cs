using System.Collections.Generic;
using UnityEngine;
using SkillApp.ChickenRun.Simulation;

namespace SkillApp.ChickenRun.View
{
    /// <summary>
    /// Renders the world the simulation describes.
    ///
    /// ── The one rule ─────────────────────────────────────────────────────────
    ///
    /// This class READS the simulation and never writes to it. It uses floats
    /// freely — positions, easing, colour — because none of it feeds back. If you
    /// ever find yourself wanting to push a value from here into Sim, that is the
    /// bug: the server does not run this code, so anything decided here does not
    /// exist as far as scoring is concerned.
    ///
    /// ── Why it draws from closed-form queries ────────────────────────────────
    ///
    /// Traffic, logs and trains are pure functions of (seed, row, tick), so the
    /// view asks the simulation where a car is at the current tick rather than
    /// keeping its own moving objects. That means the cars you see are provably
    /// the cars you can be hit by — a renderer with its own physics would drift
    /// from the thing that kills you, and the player would be hit by a gap.
    ///
    /// ── Pooling ──────────────────────────────────────────────────────────────
    ///
    /// Rows are recycled as the camera advances. A run can reach hundreds of rows
    /// and instantiating per row would stutter, which is a frame-pacing problem in
    /// a game whose whole feel is rhythm.
    /// </summary>
    public class WorldView : MonoBehaviour
    {
        [SerializeField] private ChickenRunGame game;

        /// <summary>
        /// Assigned by the scene builder to a real material asset.
        ///
        /// This MUST be a serialized reference rather than Shader.Find at
        /// runtime. A shader that no material in the scene references is stripped
        /// from a player build, so Shader.Find returns null there and every
        /// renderer draws magenta — while working perfectly in the editor, which
        /// has everything loaded. Referencing the asset is what makes the shader
        /// ship.
        /// </summary>
        [SerializeField] private Material boardMaterial;

        [Header("Visible window")]
        /// Rows drawn ahead of the chicken. Enough that the player can read and
        /// plan the next few hops, which is what makes a death feel fair.
        ///
        /// Sized from the CAMERA, not from taste: the rig is orthographic and
        /// yawed 35 degrees, so a portrait screen covers a long diagonal band of
        /// rows. 14 was enough in the editor's wide Game view and left a wedge of
        /// bare sky on a 20:9 phone.
        [SerializeField] private int rowsAhead = 24;

        /// Rows kept behind, so the ground does not visibly vanish underfoot.
        /// Generous for the same reason, and because "behind" is a large part of
        /// a yawed frame.
        [SerializeField] private int rowsBehind = 16;

        /// Cells of ground drawn either side of the playable board. Wide enough
        /// that the longest lane body is fully over ground at the moment it wraps
        /// — see BuildVerge.
        [SerializeField] private float vergeCells = 5f;

        [Header("Palette")]
        [SerializeField] private Color grassA = new Color(0.42f, 0.78f, 0.35f);
        [SerializeField] private Color grassB = new Color(0.38f, 0.73f, 0.32f);
        [SerializeField] private Color road = new Color(0.34f, 0.35f, 0.38f);
        [SerializeField] private Color rail = new Color(0.55f, 0.47f, 0.38f);
        [SerializeField] private Color water = new Color(0.30f, 0.62f, 0.88f);
        [SerializeField] private Color obstacle = new Color(0.20f, 0.45f, 0.22f);
        [SerializeField] private Color vehicle = new Color(0.90f, 0.35f, 0.30f);
        [SerializeField] private Color log = new Color(0.55f, 0.38f, 0.22f);
        [SerializeField] private Color train = new Color(0.85f, 0.80f, 0.25f);
        [SerializeField] private Color signalOn = new Color(1f, 0.25f, 0.20f);

        /// <summary>
        /// The advancing kill line. Deliberately readable, not subtle.
        ///
        /// Opaque, not alpha-blended: the board shares one unlit OPAQUE material,
        /// so alpha is ignored. Rather than introduce a second transparent
        /// material and a sorting problem for one band, it darkens by lerping the
        /// colour itself, which reads the same at a fraction of the complexity.
        /// </summary>
        [SerializeField] private Color idleShadowNear = new Color(0.22f, 0.26f, 0.34f);
        [SerializeField] private Color idleShadowClose = new Color(0.05f, 0.05f, 0.11f);

        /// <summary>
        /// Height of a row's top surface.
        ///
        /// Rows are unit cubes centred on y=0, so everything that stands on the
        /// board is placed against this and not against zero. Named because
        /// three separate props were placed against zero and each one looked
        /// like a different bug.
        /// </summary>
        internal const float GroundY = 0.5f;

        private readonly Dictionary<int, GameObject> _rows = new Dictionary<int, GameObject>();
        private readonly Stack<GameObject> _rowPool = new Stack<GameObject>();
        private readonly List<GameObject> _movers = new List<GameObject>();

        // One pool per PROP KIND, not one pool of cubes.
        //
        // A vehicle is now an assembly of a chassis, a cabin, glass, four wheels
        // and a lamp, so it cannot be recycled as a log. Keeping the pools
        // separate is what lets the props stay composite AND stay pooled — the
        // alternative is rebuilding a dozen child objects every frame.
        private readonly Stack<GameObject> _vehiclePool = new Stack<GameObject>();
        private readonly Stack<GameObject> _logPool = new Stack<GameObject>();
        private readonly Stack<GameObject> _trainPool = new Stack<GameObject>();
        private readonly Stack<GameObject> _plainPool = new Stack<GameObject>();

        private readonly Dictionary<GameObject, Stack<GameObject>> _moverOwner =
            new Dictionary<GameObject, Stack<GameObject>>();

        private Transform _root;
        private Material _sharedMaterial;

        private void Awake()
        {
            _root = new GameObject("WorldRoot").transform;
            _root.SetParent(transform, false);

            // One unlit material, instanced per renderer via a property block.
            // A stylised low-poly board needs no lighting model, and unlit is
            // dramatically cheaper on the mid-range Android this targets.
            if (boardMaterial != null)
            {
                _sharedMaterial = boardMaterial;
            }
            else
            {
                // Editor-only convenience so the scene still renders if it was
                // opened before the builder assigned the asset. Never relied on
                // in a build — see the field comment.
                var shader = Shader.Find("Universal Render Pipeline/Unlit")
                             ?? Shader.Find("Unlit/Color");
                if (shader == null)
                {
                    Debug.LogError(
                        "[world] no board material assigned and the unlit shader was " +
                        "stripped from this build; everything will draw magenta.");
                    return;
                }
                _sharedMaterial = new Material(shader);
            }
        }

        private void LateUpdate()
        {
            if (game == null || game.State == null) return;
            Redraw(game.State);
        }

        private void Redraw(Sim.State state)
        {
            int centre = state.Row;
            // NOT clamped at row 0. The board starts at row 0 but the camera can
            // see well behind it, and clamping left the bottom-right of the frame
            // as raw background — the world looked like it was floating on a blue
            // void for the first several hops of every run, which is exactly the
            // moment a player is deciding whether this is a real game.
            //
            // Negative rows are free: Sim.RowTypeAt returns grass for any row <= 2,
            // so the run-up renders as plain field and carries no hazards, no
            // lanes and no meaning to the simulation.
            int from = centre - rowsBehind;
            int to = centre + rowsAhead;

            // Recycle rows that have left the window.
            var stale = new List<int>();
            foreach (var kv in _rows)
            {
                if (kv.Key < from || kv.Key > to) stale.Add(kv.Key);
            }
            foreach (var row in stale)
            {
                var go = _rows[row];
                go.SetActive(false);
                _rowPool.Push(go);
                _rows.Remove(row);
            }

            for (int row = from; row <= to; row++)
            {
                if (!_rows.ContainsKey(row)) _rows[row] = BuildRow(state.Seed, row);
            }

            RedrawMovers(state, from, to);
            TintRows(state);
        }

        private GameObject BuildRow(uint seed, int row)
        {
            var go = _rowPool.Count > 0 ? _rowPool.Pop() : BuildQuad("Row", Color.white);
            go.SetActive(true);
            go.transform.SetParent(_root, false);
            go.transform.localScale = new Vector3(Sim.Cols, 1f, 1f);
            go.transform.localPosition = new Vector3((Sim.Cols - 1) * 0.5f, 0f, row);

            int kind = Sim.RowTypeAt(seed, row);
            // Colour is applied by TintRows, not here: the idle line darkens the
            // ground it has already claimed, so a row's colour is a function of
            // the current tick and cannot be baked in when the row is recycled.
            BuildVerge(go);

            // Static obstacles sit on the row itself; they never move, so they are
            // built once with the row rather than every frame.
            var existing = go.GetComponent<RowObstacles>() ?? go.AddComponent<RowObstacles>();
            existing.Rebuild(this, seed, row, kind);

            return go;
        }

        /// <summary>
        /// The strip of ground either side of the playable board.
        ///
        /// The board is exactly Sim.Cols wide because that is the width the
        /// simulation knows about, and for a while the renderer was that width
        /// too. That is wrong for a lane that WRAPS: a car or a log straddling
        /// the wrap point is drawn twice, once arriving and once leaving, and the
        /// leaving half hung off the edge of the world into open sky. Nothing
        /// else in the frame said "this is a board", so it read as a rendering
        /// fault rather than as a boundary.
        ///
        /// So every row gets a wider apron in its own colour, a shade darker and
        /// a hair lower, and a wrapping body passes over ground on its way out.
        /// The darker tone is doing a second job: it marks where the chicken may
        /// not go. The simulation already clamps to the board, and now the board
        /// looks clamped too.
        ///
        /// It is a child of the row rather than a pooled object of its own so it
        /// is recycled with the row for free — and because the row's non-uniform
        /// scale is exactly the frame the width is easiest to express in.
        /// </summary>
        private void BuildVerge(GameObject row)
        {
            var verge = row.transform.Find("Verge");
            if (verge == null)
            {
                var go = BuildQuad("Verge", Color.white);
                go.transform.SetParent(row.transform, false);
                verge = go.transform;
            }

            verge.localScale = new Vector3((Sim.Cols + vergeCells * 2f) / Sim.Cols, 0.98f, 1f);
            // Just under the row surface, so the two never fight for the same
            // pixels and the edge of the playable board reads as a small step.
            verge.localPosition = new Vector3(0f, -0.02f, 0f);
        }

        /// <summary>Draw everything that moves, straight from the closed-form queries.</summary>
        private void RedrawMovers(Sim.State state, int from, int to)
        {
            foreach (var m in _movers)
            {
                m.SetActive(false);
                if (_moverOwner.TryGetValue(m, out var pool)) pool.Push(m);
            }
            _movers.Clear();

            // The renderer interpolates between ticks so 50Hz logic reads as
            // continuous motion. This is float maths on top of an integer
            // simulation, which is exactly where floats belong.
            float tick = state.Tick + game.TickAlpha;

            for (int row = from; row <= to; row++)
            {
                int kind = Sim.RowTypeAt(state.Seed, row);

                if (kind == Sim.RowRoad || kind == Sim.RowRiver)
                {
                    var lane = Sim.LaneTraffic(state.Seed, row, kind);
                    bool isRoad = kind == Sim.RowRoad;
                    for (int i = 0; i < lane.Count; i++)
                    {
                        float posSub = InterpolatedBodyPos(lane, i, tick);
                        float cells = lane.LengthSub / (float)Sim.Sub;
                        float x = posSub / Sim.Sub + cells * 0.5f - 0.5f;

                        Color paint = isRoad ? VehicleColour(row, i) : log;
                        var go = isRoad ? TakeVehicle(paint) : TakeLog();

                        // Vehicles face the way they travel, so the headlamp and
                        // windscreen are at the leading end rather than whichever
                        // end the model happens to have.
                        if (isRoad && lane.Dir < 0)
                        {
                            go.transform.localRotation = Quaternion.Euler(0f, 180f, 0f);
                        }

                        // Sit ON the row, not IN it. Rows are unit cubes centred
                        // at y=0, so their surface is y=0.5 — and the original
                        // code placed movers at y≈0, which buried half of every
                        // car in the tarmac. That is most of why traffic read as
                        // painted rectangles rather than as vehicles.
                        // A truck is taller than a car. One number, and it is
                        // the difference between "two lengths of the same
                        // vehicle" and a road with traffic on it.
                        float height = isRoad ? (cells > 1.5f ? 0.92f : 0.72f) : 0.36f;
                        go.transform.localScale = new Vector3(cells, height, isRoad ? 0.72f : 0.78f);
                        go.transform.localPosition = new Vector3(x, 0.5f + height * 0.5f, row);

                        // A body straddling the wrap point must be drawn twice or
                        // it visibly pops out of existence at the board edge.
                        if (posSub + lane.LengthSub > Sim.TrackSub)
                        {
                            var wrap = isRoad ? TakeVehicle(paint) : TakeLog();
                            wrap.transform.localRotation = go.transform.localRotation;
                            wrap.transform.localScale = go.transform.localScale;
                            wrap.transform.localPosition =
                                go.transform.localPosition - new Vector3(Sim.Cols, 0f, 0f);
                        }
                    }
                }
                else if (kind == Sim.RowRail)
                {
                    var sched = Sim.RailSchedule(state.Seed, row);
                    if (Sim.TrainPresent(sched, state.Tick))
                    {
                        var go = TakeTrain();
                        const float trainHeight = 1.05f;
                        go.transform.localScale = new Vector3(Sim.Cols, trainHeight, 0.72f);
                        go.transform.localPosition =
                            new Vector3((Sim.Cols - 1) * 0.5f, 0.5f + trainHeight * 0.5f, row);
                    }
                    else if (Sim.TrainWarning(sched, state.Tick))
                    {
                        // The signal is driven by the SAME schedule the simulation
                        // kills from, so a flashing light always means a train is
                        // genuinely coming. A cosmetic signal would teach the
                        // player a timing that is not real.
                        float blink = Mathf.PingPong(Time.unscaledTime * 6f, 1f);

                        // A post, so the light is at head height rather than
                        // lying on the sleepers.
                        const float postHeight = 1.1f;
                        var post = TakePlain(new Color(0.30f, 0.30f, 0.33f));
                        post.transform.localScale = new Vector3(0.12f, postHeight, 0.12f);
                        post.transform.localPosition =
                            new Vector3(-0.35f, GroundY + postHeight * 0.5f, row);

                        var lamp = TakePlain(Color.Lerp(new Color(0.25f, 0.05f, 0.05f), signalOn, blink));
                        lamp.transform.localScale = new Vector3(0.30f, 0.30f, 0.30f);
                        lamp.transform.localPosition =
                            new Vector3(-0.35f, GroundY + postHeight + 0.05f, row);
                    }
                }
            }
        }

        /// <summary>
        /// Where a body sits between ticks.
        ///
        /// Deliberately recomputed from the lane parameters rather than lerping
        /// between two BodyPos calls: near the wrap point those two values are a
        /// whole board apart, and lerping them sends the car sprinting backwards
        /// across the screen for one frame.
        /// </summary>
        private static float InterpolatedBodyPos(Sim.Lane lane, int i, float tick)
        {
            float raw = lane.Offset + i * lane.Gap + lane.Dir * lane.Speed * tick;
            float wrapped = raw % Sim.TrackSub;
            if (wrapped < 0) wrapped += Sim.TrackSub;
            return wrapped;
        }

        /// <summary>The colour a row would be with nothing chasing the player.</summary>
        private Color RowBaseColour(uint seed, int row)
        {
            switch (Sim.RowTypeAt(seed, row))
            {
                case Sim.RowRoad: return road;
                case Sim.RowRail: return rail;
                case Sim.RowRiver: return water;
                // Alternating grass bands give the eye a sense of forward motion
                // that a single flat colour does not.
                default: return (row % 2 == 0) ? grassA : grassB;
            }
        }

        /// <summary>
        /// Colour every visible row, and darken the ground the idle line has taken.
        ///
        /// -- Why this is not a shadow object --------------------------------
        ///
        /// It was, for three versions, and each one failed differently. A 1-unit
        /// cube at y=0.3 spanned the chicken's own height and hid it behind the
        /// very thing chasing it. Flattened to a 0.02 sheet it went UNDER the
        /// board and was invisible for every run after that. Lifted onto the
        /// board it became a hard-edged navy rectangle lying on bright grass —
        /// the board shares one OPAQUE material, so it could never be a soft
        /// alpha gradient, and an opaque quad on grass reads as a hole.
        ///
        /// Darkening the ROWS has none of those failure modes. There is no
        /// object to occlude the chicken, nothing to place at the wrong height,
        /// no edge that fails to follow the terrain, and fading over the two rows
        /// in front of the line does the softening alpha would have done. It
        /// costs one property block per visible row per frame and no draw calls.
        ///
        /// The line it draws is the same one the simulation kills from, so the
        /// dark ground is exactly the ground that is no longer safe.
        /// </summary>
        private void TintRows(Sim.State state)
        {
            // Only once the line is actually MOVING — i.e. the grace period has
            // expired and the player is being pushed.
            //
            // An earlier version tested `line >= row - IdleLeadRows`, which is
            // true on the very first tick of every run (the line rests exactly
            // IdleLeadRows behind), so the warning was permanently on screen and
            // had stopped being a warning at all.
            bool threatening = state.Tick - state.LastAdvanceTick > Sim.IdleGraceTicks;
            int line = threatening ? Sim.IdleLineRow(state) : int.MinValue;

            // How close the line is to the chicken, so the ground goes darker as
            // the pressure rises rather than sitting at one flat tone.
            float urgency = threatening
                ? Mathf.InverseLerp(state.Row - 5f, state.Row, line)
                : 0f;

            foreach (var kv in _rows)
            {
                int row = kv.Key;
                var c = RowBaseColour(state.Seed, row);

                if (threatening)
                {
                    // Full strength behind the line, fading out over the two rows
                    // ahead of it so the boundary is a gradient and not a step.
                    float taken = Mathf.Clamp01((line - row + 2f) / 2.5f);
                    if (taken > 0f)
                    {
                        var dark = Color.Lerp(idleShadowNear, idleShadowClose, urgency);
                        c = Color.Lerp(c, dark, taken * 0.85f);
                    }
                }

                Tint(kv.Value, c);
                var verge = kv.Value.transform.Find("Verge");
                if (verge != null) Tint(verge.gameObject, Props.Shade(c, 0.18f));
            }
        }

        private GameObject Take(Stack<GameObject> pool, System.Func<GameObject> build)
        {
            var go = pool.Count > 0 ? pool.Pop() : build();
            go.SetActive(true);
            go.transform.SetParent(_root, false);
            go.transform.localRotation = Quaternion.identity;
            _movers.Add(go);
            _moverOwner[go] = pool;
            return go;
        }

        /// <summary>An empty parent holding a composite prop. Scaled like the old cube.</summary>
        private GameObject BuildAssembly(string name, System.Action<Transform> build)
        {
            var go = new GameObject(name);
            go.transform.SetParent(_root, false);
            build(go.transform);
            return go;
        }

        private GameObject TakeVehicle(Color body)
        {
            var go = Take(_vehiclePool,
                () => BuildAssembly("Vehicle", t => Props.BuildVehicle(t, _sharedMaterial, body)));
            // Recolour the chassis and cabin on reuse so a pooled car is not
            // always the colour of the first car that used that slot.
            Recolour(go, "Body", body);
            Recolour(go, "Cabin", Props.Lift(body, 0.12f));
            return go;
        }

        private GameObject TakeLog() =>
            Take(_logPool, () => BuildAssembly("Log", t => Props.BuildLog(t, _sharedMaterial, log)));

        private GameObject TakeTrain() =>
            Take(_trainPool, () => BuildAssembly("Train", t => Props.BuildTrain(t, _sharedMaterial, train)));

        private GameObject TakePlain(Color color)
        {
            var go = Take(_plainPool, () => BuildQuad("Plain", Color.white));
            Tint(go, color);
            return go;
        }

        private static void Recolour(GameObject assembly, string childName, Color color)
        {
            var child = assembly.transform.Find(childName);
            if (child != null) Props.Tint(child.gameObject, color);
        }

        /// <summary>
        /// Traffic colour, derived from the lane rather than random.
        ///
        /// A random colour per frame would strobe; a single colour for every
        /// vehicle makes a busy road read as one moving mass. Deriving it from
        /// the row means a lane keeps its colour for as long as it is on screen,
        /// which is what lets a player track one car.
        /// </summary>
        private Color VehicleColour(int row, int index)
        {
            var palette = new[]
            {
                new Color(0.90f, 0.35f, 0.30f),
                new Color(0.36f, 0.55f, 0.86f),
                new Color(0.96f, 0.78f, 0.28f),
                new Color(0.42f, 0.74f, 0.45f),
                new Color(0.85f, 0.85f, 0.88f),
                new Color(0.62f, 0.40f, 0.76f),
            };
            int h = row * 7919 + index * 104729;
            return palette[((h % palette.Length) + palette.Length) % palette.Length];
        }

        /// <summary>The one shared board material, for props built by other objects.</summary>
        internal Material SharedMaterial => _sharedMaterial;

        /// <summary>An empty parent under `parent`, filled by `build`.</summary>
        internal GameObject BuildAssemblyChild(
            Transform parent, string name, System.Action<Transform> build)
        {
            var go = new GameObject(name);
            go.transform.SetParent(parent, false);
            build(go.transform);
            return go;
        }

        internal GameObject BuildQuad(string name, Color color)
        {
            // NOT GameObject.CreatePrimitive. It attaches a collider, and the
            // Physics module is stripped from the player build because nothing in
            // this game uses it — so on device CreatePrimitive fails with
            // "Can't add component because class 'BoxCollider' doesn't exist",
            // the world never finishes building, and Unity never sends READY.
            // Invisible in the editor, fatal on a phone. See PrimitiveMesh.
            var go = PrimitiveMesh.CubeObject(name, _sharedMaterial);
            Tint(go, color);
            return go;
        }

        internal void Tint(GameObject go, Color color)
        {
            var r = go.GetComponent<MeshRenderer>();
            var block = new MaterialPropertyBlock();
            r.GetPropertyBlock(block);
            // URP Unlit uses _BaseColor; the built-in fallback uses _Color.
            block.SetColor("_BaseColor", color);
            block.SetColor("_Color", color);
            r.SetPropertyBlock(block);
        }

        internal Color ObstacleColor => obstacle;
    }

    /// <summary>Static scenery for one row, built once when the row is recycled in.</summary>
    public class RowObstacles : MonoBehaviour
    {
        private readonly List<GameObject> _spawned = new List<GameObject>();

        public void Rebuild(WorldView world, uint seed, int row, int kind)
        {
            foreach (var go in _spawned) Destroy(go);
            _spawned.Clear();

            // Static dressing per row type. None of it is known to the
            // simulation: trees stand where the obstacle mask says a cell is
            // blocked, and everything else is paint.
            if (kind == Sim.RowGrass)
            {
                int mask = Sim.GrassObstacleMask(seed, row);
                for (int col = 0; col < Sim.Cols; col++)
                {
                    if ((mask & (1 << col)) == 0) continue;

                    var tree = world.BuildAssemblyChild(transform, "Tree",
                        t => Props.BuildTree(t, world.SharedMaterial, world.ObstacleColor));
                    // Undo the parent row's non-uniform scale so props stay square.
                    //
                    // 0.60, down from 1.25, and the height is the whole point.
                    // The Props model is 1.205 units tall at scale 1, so 1.25
                    // made a tree a foot and a half taller than the chicken —
                    // and in a camera tilted this far, an object that tall is
                    // drawn a row and a half UP the screen. Trees on the grass
                    // beside a road covered the road, which is how a lane of
                    // clean grey tarmac came to look like it had grass growing
                    // in it. At 0.60 a tree is 0.72 units, roughly two thirds of
                    // the chicken, and it stays on its own row.
                    const float treeScale = 0.60f;
                    tree.transform.localScale =
                        new Vector3(0.72f / Sim.Cols, treeScale, 0.72f);
                    // Stand the trunk ON the row. The Props model reaches 0.505
                    // below its own origin, so at the old 0.62 the entire trunk
                    // and the underside of the canopy were inside the row cube —
                    // which is why a tree rendered as a green box sitting flush
                    // on the grass with no visible trunk at all.
                    tree.transform.localPosition = new Vector3(
                        (col - (Sim.Cols - 1) * 0.5f) / Sim.Cols,
                        WorldView.GroundY + 0.505f * treeScale, 0f);
                    _spawned.Add(tree);
                }
                return;
            }

            if (kind == Sim.RowRoad)
            {
                // A dashed centre line. It does nothing mechanically and it is
                // the single cheapest thing that makes a grey band read as a
                // road rather than as a gap in the grass.
                for (int i = 0; i < 5; i++)
                {
                    var dash = world.BuildQuad("Dash", new Color(0.86f, 0.84f, 0.72f));
                    dash.transform.SetParent(transform, false);
                    dash.transform.localScale = new Vector3(0.5f / Sim.Cols, 0.02f, 0.06f);
                    dash.transform.localPosition =
                        new Vector3((i - 2f) * 1.8f / Sim.Cols, 0.51f, 0f);
                    _spawned.Add(dash);
                }
                return;
            }

            if (kind == Sim.RowRail)
            {
                // Two rails and the sleepers under them.
                foreach (float z in new[] { -0.16f, 0.16f })
                {
                    var railBar = world.BuildQuad("Rail", new Color(0.62f, 0.62f, 0.66f));
                    railBar.transform.SetParent(transform, false);
                    railBar.transform.localScale = new Vector3(1f, 0.05f, 0.07f);
                    railBar.transform.localPosition = new Vector3(0f, 0.53f, z);
                    _spawned.Add(railBar);
                }
                for (int i = 0; i < 9; i++)
                {
                    var sleeper = world.BuildQuad("Sleeper", new Color(0.40f, 0.31f, 0.23f));
                    sleeper.transform.SetParent(transform, false);
                    sleeper.transform.localScale = new Vector3(0.24f / Sim.Cols, 0.03f, 0.52f);
                    sleeper.transform.localPosition =
                        new Vector3((i - 4f) * 1.0f / Sim.Cols, 0.51f, 0f);
                    _spawned.Add(sleeper);
                }
                return;
            }

            if (kind == Sim.RowRiver)
            {
                // Banks. Water that runs edge to edge reads as a hole; a lighter
                // lip on each side reads as a river.
                foreach (float z in new[] { -0.46f, 0.46f })
                {
                    var bank = world.BuildQuad("Bank", new Color(0.52f, 0.78f, 0.92f));
                    bank.transform.SetParent(transform, false);
                    bank.transform.localScale = new Vector3(1f, 0.06f, 0.09f);
                    bank.transform.localPosition = new Vector3(0f, 0.50f, z);
                    _spawned.Add(bank);
                }
            }
        }

        private void OnDestroy()
        {
            foreach (var go in _spawned) if (go != null) Destroy(go);
            _spawned.Clear();
        }
    }
}
